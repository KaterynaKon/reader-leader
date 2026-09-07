"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

const VOICE_RMS_THRESHOLD = 0.028;
const VAD_WARMUP_MS = 300;
const SUSTAINED_SPEECH_MS = 90;
const SPEECH_RELEASE_MS = 180;
const UI_SAMPLE_INTERVAL_MS = 100;

// Редюсер для FSM
type HesitationPhase = "idle" | "request_permission" | "listening" | "speaking" | "hesitating" | "prompting" | "finished" | "failed";

interface HesitationState {
  phase: HesitationPhase;
  lastSpeechAt: number | null;
  silenceDurationMs: number;
  speechStartAt: number | null;
  speechEndAt: number | null;
}

const INITIAL_HESITATION_MACHINE: HesitationState = {
  phase: "idle",
  lastSpeechAt: null,
  silenceDurationMs: 0,
  speechStartAt: null,
  speechEndAt: null,
};

type HesitationAction =
  | { type: "REQUEST_PERMISSION" }
  | { type: "PERMISSION_GRANTED"; atMs: number }
  | { type: "PERMISSION_DENIED" }
  | { type: "SPEECH"; atMs: number }
  | { type: "SILENCE"; atMs: number }
  | { type: "CLEAR_HESITATION"; atMs: number }
  | { type: "BEGIN_FINISH" }
  | { type: "FINISHED" }
  | { type: "RESET" }
  | { type: "FAIL" }
  | { type: "UNSUPPORTED" };

export function hesitationReducer(state: HesitationState, action: HesitationAction): HesitationState {
  switch (action.type) {
    case "REQUEST_PERMISSION":
      return { ...state, phase: "request_permission" };
    case "PERMISSION_GRANTED":
      return { ...state, phase: "listening", lastSpeechAt: action.atMs, speechStartAt: null, speechEndAt: null, silenceDurationMs: 0 };
    case "PERMISSION_DENIED":
    case "FAIL":
    case "UNSUPPORTED":
      return { ...state, phase: "failed" };
    case "SPEECH":
      return {
        ...state,
        phase: state.phase === "listening" || state.phase === "speaking" ? "speaking" : state.phase,
        lastSpeechAt: action.atMs,
        speechStartAt: state.speechStartAt ?? action.atMs,
        speechEndAt: null,
        silenceDurationMs: 0,
      };
    case "SILENCE": {
      const silenceDurationMs = state.lastSpeechAt ? action.atMs - state.lastSpeechAt : 0;
      const isHesitating = state.phase === "speaking" && silenceDurationMs > 2000;
      const isPrompting = state.phase === "hesitating" && silenceDurationMs > 4000;
      return {
        ...state,
        phase: isPrompting ? "prompting" : isHesitating ? "hesitating" : state.phase,
        speechEndAt: action.atMs,
        silenceDurationMs,
      };
    }
    case "CLEAR_HESITATION":
      return { ...state, phase: "listening", silenceDurationMs: 0 };
    case "BEGIN_FINISH":
      return { ...state, phase: "finished" };
    case "FINISHED":
      return { ...state, phase: "idle" };
    case "RESET":
      return INITIAL_HESITATION_MACHINE;
    default:
      return state;
  }
}

export interface TimedAudioChunk {
  blob: Blob;
  endMs: number;
}

export interface AudioCaptureResult {
  blob: Blob | null;
  chunks: TimedAudioChunk[];
  snippetBlob: Blob | null;
  elapsedMs: number;
}

const ATTEMPT_SNIPPET_DURATION_MS = 2000;
const ATTEMPT_SNIPPET_PRE_ROLL_MS = 500;

function createAttemptSnippetWindow(tokenStartMs: number) {
  return {
    startMs: Math.max(0, tokenStartMs - ATTEMPT_SNIPPET_PRE_ROLL_MS),
    durationMs: ATTEMPT_SNIPPET_DURATION_MS,
  };
}

async function sliceAudioBlobToWav(blob: Blob, startMs: number, durationMs: number): Promise<Blob | null> {
  // Спрощена версія — повертаємо оригінальний blob
  return blob;
}

export function useHesitationFSM() {
  const [machine, dispatch] = useReducer(hesitationReducer, INITIAL_HESITATION_MACHINE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [speechStartedEpoch, setSpeechStartedEpoch] = useState(0);
  const [speechEndedEpoch, setSpeechEndedEpoch] = useState(0);
  const [speechStartedAtMs, setSpeechStartedAtMs] = useState(0);
  
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const snippetWindowRef = useRef<{ startMs: number; durationMs: number } | null>(null);
  const chunksRef = useRef<TimedAudioChunk[]>([]);
  const frameRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const lastVoiceAtRef = useRef<number | null>(null);
  const voiceCandidateStartedAtRef = useRef<number | null>(null);
  const lastUiDispatchAtRef = useRef(0);
  const speakingRef = useRef(false);

  // ===== ДОДАНО: Ref для зберігання аудіо-блоба =====
  const audioBlobRef = useRef<Blob | null>(null);

  const disconnectAudioGraph = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.stop();
    }
    recorderRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const audioContext = contextRef.current;
    contextRef.current = null;
    if (audioContext && audioContext.state !== "closed") void audioContext.close().catch(() => undefined);

    lastVoiceAtRef.current = null;
    voiceCandidateStartedAtRef.current = null;
    lastUiDispatchAtRef.current = 0;
    speakingRef.current = false;
  }, []);

  const captureSnippet = useCallback((tokenStartMs: number): void => {
    if (snippetWindowRef.current) return;
    const window = createAttemptSnippetWindow(tokenStartMs);
    snippetWindowRef.current = { startMs: Math.max(0, window.startMs), durationMs: window.durationMs };
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    disconnectAudioGraph();
    chunksRef.current = [];
    snippetWindowRef.current = null;
    // ===== ДОДАНО: Очищаємо аудіо-блоб при старті =====
    audioBlobRef.current = null;
    setSpeechStartedEpoch(0);
    setSpeechEndedEpoch(0);
    setSpeechStartedAtMs(0);
    setErrorMessage(null);

    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      dispatch({ type: "UNSUPPORTED" });
      setErrorMessage("Live listening is not supported in this browser.");
      return false;
    }

    dispatch({ type: "REQUEST_PERMISSION" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const audioContext = new window.AudioContext();
      if (audioContext.state === "suspended") await audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.25;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      streamRef.current = stream;
      contextRef.current = audioContext;
      analyserRef.current = analyser;
      sourceRef.current = source;
      startedAtRef.current = performance.now();
      lastVoiceAtRef.current = null;
      voiceCandidateStartedAtRef.current = null;

      if (typeof MediaRecorder !== "undefined") {
        const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
          .find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
        
        // ===== ДОДАНО: Зберігаємо аудіо-блоб при зупинці =====
        recorder.ondataavailable = (event) => {
          if (event.data.size === 0) return;
          const endMs = startedAtRef.current === null ? 0 : performance.now() - startedAtRef.current;
          chunksRef.current.push({ blob: event.data, endMs });
          // Зберігаємо останній фрагмент як аудіо-блоб
          audioBlobRef.current = event.data;
        };
        recorder.onerror = () => setErrorMessage("Recording error");
        recorder.start(250);
        recorderRef.current = recorder;
      }

      const samples = new Uint8Array(analyser.fftSize);
      const sample = (now: number) => {
        const activeAnalyser = analyserRef.current;
        if (!activeAnalyser) return;
        activeAnalyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) {
          const normalised = (value - 128) / 128;
          energy += normalised * normalised;
        }
        const rms = Math.sqrt(energy / samples.length);
        const startedAt = startedAtRef.current;
        if (startedAt !== null && now - startedAt < VAD_WARMUP_MS) {
          lastVoiceAtRef.current = null;
          voiceCandidateStartedAtRef.current = null;
          speakingRef.current = false;
          frameRef.current = requestAnimationFrame(sample);
          return;
        }

        if (rms >= VOICE_RMS_THRESHOLD) {
          if (speakingRef.current) {
            lastVoiceAtRef.current = now;
          } else {
            voiceCandidateStartedAtRef.current ??= now;
            if (now - voiceCandidateStartedAtRef.current >= SUSTAINED_SPEECH_MS) lastVoiceAtRef.current = now;
          }
        } else {
          voiceCandidateStartedAtRef.current = null;
        }

        if (now - lastUiDispatchAtRef.current >= UI_SAMPLE_INTERVAL_MS) {
          lastUiDispatchAtRef.current = now;
          const recentlySpeaking = lastVoiceAtRef.current !== null && now - lastVoiceAtRef.current < SPEECH_RELEASE_MS;
          if (recentlySpeaking && !speakingRef.current) {
            const sessionStartedAt = startedAtRef.current ?? now;
            const detectedStart = voiceCandidateStartedAtRef.current ?? now;
            setSpeechStartedAtMs(Math.max(0, detectedStart - sessionStartedAt));
            setSpeechStartedEpoch((current) => current + 1);
          }
          if (!recentlySpeaking && speakingRef.current) setSpeechEndedEpoch((current) => current + 1);
          speakingRef.current = recentlySpeaking;
          dispatch({ type: recentlySpeaking ? "SPEECH" : "SILENCE", atMs: now });
        }
        frameRef.current = requestAnimationFrame(sample);
      };

      dispatch({ type: "PERMISSION_GRANTED", atMs: startedAtRef.current });
      frameRef.current = requestAnimationFrame(sample);
      return true;
    } catch (error) {
      disconnectAudioGraph();
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      dispatch({ type: denied ? "PERMISSION_DENIED" : "FAIL" });
      setErrorMessage(denied
        ? "Microphone access was not granted."
        : "The microphone could not start.");
      return false;
    }
  }, [disconnectAudioGraph]);

  const finish = useCallback(async (): Promise<AudioCaptureResult> => {
    dispatch({ type: "BEGIN_FINISH" });
    const elapsedMs = startedAtRef.current === null ? 5000 : Math.max(performance.now() - startedAtRef.current, 1000);
    const recorder = recorderRef.current;
    const snippetWindow = snippetWindowRef.current;

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    let blob: Blob | null = null;
    if (recorder && recorder.state !== "inactive") {
      blob = await new Promise<Blob>((resolve) => {
        const finishRecording = () => resolve(new Blob(chunksRef.current.map((chunk) => chunk.blob), { type: recorder.mimeType || "audio/webm" }));
        recorder.addEventListener("stop", finishRecording, { once: true });
        recorder.stop();
      });
      // ===== ДОДАНО: Зберігаємо фінальний блоб =====
      audioBlobRef.current = blob;
    } else if (chunksRef.current.length > 0) {
      blob = new Blob(chunksRef.current.map((chunk) => chunk.blob), { type: chunksRef.current[0].blob.type || "audio/webm" });
      audioBlobRef.current = blob;
    }

    let snippetBlob: Blob | null = null;
    if (blob && snippetWindow) {
      try {
        snippetBlob = await sliceAudioBlobToWav(blob, snippetWindow.startMs, snippetWindow.durationMs);
      } catch {
        setErrorMessage("Could not prepare snippet.");
      }
    }

    const chunks = [...chunksRef.current];
    recorderRef.current = null;
    disconnectAudioGraph();
    startedAtRef.current = null;
    snippetWindowRef.current = null;
    dispatch({ type: "FINISHED" });
    return { blob, chunks, snippetBlob, elapsedMs };
  }, [disconnectAudioGraph]);

  const cancel = useCallback(() => {
    disconnectAudioGraph();
    startedAtRef.current = null;
    chunksRef.current = [];
    snippetWindowRef.current = null;
    // ===== ДОДАНО: Очищаємо аудіо-блоб =====
    audioBlobRef.current = null;
    setSpeechStartedAtMs(0);
    setErrorMessage(null);
    dispatch({ type: "RESET" });
  }, [disconnectAudioGraph]);

  const clearHesitation = useCallback(() => {
    dispatch({ type: "CLEAR_HESITATION", atMs: performance.now() });
  }, []);

  // ===== ДОДАНО: Функція для отримання аудіо-блоба =====
  const getAudioBlob = useCallback(() => {
    return audioBlobRef.current;
  }, []);

  useEffect(() => disconnectAudioGraph, [disconnectAudioGraph]);

  return {
    ...machine,
    errorMessage,
    speechStartedEpoch,
    speechStartedAtMs,
    speechEndedEpoch,
    isActive: ["listening", "speaking", "hesitating", "prompting"].includes(machine.phase),
    start,
    captureSnippet,
    clearHesitation,
    finish,
    cancel,
    getAudioBlob, // ===== ДОДАНО: повертаємо функцію =====
  };
}