"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";
import { useHesitationFSM } from "@/hooks/use-hesitation-fsm";
import { alignWords, AlignedItem } from "@/lib/aligner";
import { createSession } from '@/lib/api';

// ----------------------------------------------------------------------
// TYPES
// ----------------------------------------------------------------------

type WordStatus =
  | "waiting"
  | "current"
  | "correct"
  | "prompted"
  | "self-corrected"
  | "modelled"
  | "skipped"
  | "error";

type WordState = {
  word: string;
  status: WordStatus;
  accuracy?: number;
};

type Decision = "STAY_SILENT" | "WAIT" | "PROMPT" | "MODEL" | "SKIPPED" | "ERROR";

type DecisionRecord = {
  word: string;
  action: Decision;
  reason: string;
  accuracy?: number;
  timestamp: number;
};

type ReadingLevel = "beginner" | "intermediate" | "advanced";
type ReadingMode = "slow" | "fast";

interface StudentProfile {
  id: string;
  name: string;
  age: number;
  readingLevel: ReadingLevel;
  preferredAccent: "en-IE" | "en-GB" | "en-US";
  stats: {
    averageWCPM: number;
    averageAccuracy: number;
    totalSessions: number;
    lastSessionDate: string;
  };
}

interface CorrectionStrategy {
  checkRate: number;
  promptDelayMs: number;
  modelDelayMs: number;
  minAccuracy: number;
  checkAllShortTexts: boolean;
}

interface AzureWordResult {
  Word: string;
  PronunciationAssessment?: {
    AccuracyScore?: number;
    ErrorType?: string;
  };
}

// ----------------------------------------------------------------------
// CONFIG & HELPERS
// ----------------------------------------------------------------------

const TEST_STUDENT: StudentProfile = {
  id: "student_123",
  name: "Emma",
  age: 9,
  readingLevel: "intermediate",
  preferredAccent: "en-IE",
  stats: {
    averageWCPM: 85,
    averageAccuracy: 78,
    totalSessions: 5,
    lastSessionDate: new Date().toISOString(),
  },
};

const REFERENCE_TEXT = "The cat sat on the mat.";
const REFERENCE_WORDS = REFERENCE_TEXT.replace(/[.,!?]/g, "").split(" ");
const CHECK_INTERVAL_MS = 200;

function phonicsHint(word: string) {
  return word.length > 0 ? `${word[0]}...` : "";
}

function initialWords(): WordState[] {
  return REFERENCE_WORDS.map((word, i) => ({
    word,
    status: i === 0 ? "current" : "waiting",
  }));
}

const getCorrectionStrategy = (level: ReadingLevel): CorrectionStrategy => {
  switch (level) {
    case "beginner":
      return { checkRate: 1.0, promptDelayMs: 4000, modelDelayMs: 3000, minAccuracy: 30, checkAllShortTexts: true };
    case "intermediate":
      return { checkRate: 0.7, promptDelayMs: 4000, modelDelayMs: 3000, minAccuracy: 30, checkAllShortTexts: true };
    case "advanced":
      return { checkRate: 0.5, promptDelayMs: 3000, modelDelayMs: 2500, minAccuracy: 30, checkAllShortTexts: false };
    default:
      return { checkRate: 0.7, promptDelayMs: 4000, modelDelayMs: 3000, minAccuracy: 30, checkAllShortTexts: true };
  }
};

// ----------------------------------------------------------------------
// ОСНОВНИЙ КОМПОНЕНТ
// ----------------------------------------------------------------------

export default function Home() {
  const recognizerRef = useRef<SpeechSDK.SpeechRecognizer | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentIndexRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const promptedAtRef = useRef<number | null>(null);
  const wordsRef = useRef<WordState[]>(initialWords());
  const modelledForIndexRef = useRef<number | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const processingLockRef = useRef(false);
  const errorWordsRef = useRef<string[]>([]);
  const strategyRef = useRef<CorrectionStrategy | null>(null);
  const startTimeRef = useRef(Date.now());
  const isInitializedRef = useRef(false);
  const lastSpokenWordRef = useRef<string>("");
  const isStoppingRef = useRef(false);

  // ===== НОВИЙ СТАН ДЛЯ РЕЖИМУ =====
  const [readingMode, setReadingMode] = useState<ReadingMode>("slow");

  const {
    speechStartedEpoch,
    start: startVAD,
    finish: finishVAD,
    isActive: vadIsActive,
    errorMessage: vadError,
    // Додаємо метод для отримання аудіо-блоба
    getAudioBlob,
  } = useHesitationFSM();

  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [strategy, setStrategy] = useState<CorrectionStrategy | null>(null);
  const [studentLoading, setStudentLoading] = useState(true);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState("");
  const [words, setWords] = useState<WordState[]>(wordsRef.current);
  const [decisionTrace, setDecisionTrace] = useState<DecisionRecord[]>([]);
  const [liveHint, setLiveHint] = useState("");
  const [showTeacherView, setShowTeacherView] = useState(true);
  const [showErrorSummary, setShowErrorSummary] = useState(false);
  const [currentSpokenWord, setCurrentSpokenWord] = useState("");

  useEffect(() => {
    strategyRef.current = strategy;
  }, [strategy]);

  const commitWords = useCallback((next: WordState[]) => {
    wordsRef.current = next;
    setWords([...next]);
  }, []);

  const touchActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (promptedAtRef.current !== null && Date.now() - promptedAtRef.current > 500) {
      promptedAtRef.current = null;
    }
  }, []);

  const logDecision = useCallback((record: Omit<DecisionRecord, "timestamp">) => {
    setDecisionTrace((prev) => [...prev, { ...record, timestamp: Date.now() }]);
  }, []);

  const advanceTo = useCallback((index: number) => {
    if (index < 0 || index > REFERENCE_WORDS.length) return;

    currentIndexRef.current = index;
    promptedAtRef.current = null;
    modelledForIndexRef.current = null;
    touchActivity();

    const next = wordsRef.current.map((w, i) => {
      if (i < index) return w;
      if (i === index) return { ...w, status: "current" as WordStatus };
      return { ...w, status: "waiting" as WordStatus };
    });

    commitWords(next);
    setLiveHint("");
    setCurrentSpokenWord("");
  }, [commitWords, touchActivity]);

  const markWordStatus = useCallback((index: number, status: WordStatus, accuracy?: number) => {
    if (status === "error" || status === "modelled") {
      const word = REFERENCE_WORDS[index];
      if (word && !errorWordsRef.current.includes(word)) {
        errorWordsRef.current.push(word);
      }
    }

    const updated = wordsRef.current.map((w, i) => (i === index ? { ...w, status, accuracy } : w));
    commitWords(updated);
  }, [commitWords]);

  const speakWord = useCallback((word: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      const voices = voicesRef.current;

      const preferred =
        voices.find((v) => v.lang === "en-IE") ||
        voices.find((v) => v.lang === "en-GB") ||
        voices.find((v) => v.lang.startsWith("en"));

      if (preferred) {
        utterance.voice = preferred;
        utterance.lang = preferred.lang;
      } else {
        utterance.lang = "en-IE";
      }

      utterance.rate = 0.85;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Audio fallback
    }
  }, []);

  useEffect(() => {
    if (speechStartedEpoch > 0 && currentIndexRef.current < REFERENCE_WORDS.length) {
      touchActivity();
    }
  }, [speechStartedEpoch, touchActivity]);

  useEffect(() => {
    const loadStudent = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const studentId = params.get("student");

        const targetStudent = studentId
          ? {
              ...TEST_STUDENT,
              id: studentId,
              readingLevel: (params.get("level") as ReadingLevel) || TEST_STUDENT.readingLevel,
            }
          : TEST_STUDENT;

        const strat = getCorrectionStrategy(targetStudent.readingLevel);
        setStudent(targetStudent);
        setStrategy(strat);
        strategyRef.current = strat;
      } catch (err) {
        console.error("Failed to load student profile:", err);
        setStudent(TEST_STUDENT);
        const strat = getCorrectionStrategy(TEST_STUDENT.readingLevel);
        setStrategy(strat);
        strategyRef.current = strat;
      } finally {
        setStudentLoading(false);
      }
    };

    loadStudent();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  // ===== ФУНКЦІЯ ЗУПИНКИ ЗАПИСУ =====
  const performStop = useCallback(() => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    const recognizer = recognizerRef.current;
    if (!recognizer) {
      isStoppingRef.current = false;
      return;
    }

    finishVAD();

    recognizer.stopContinuousRecognitionAsync(
      () => {
        recognizer.close();
        recognizerRef.current = null;
        setIsRecording(false);
        if (errorWordsRef.current.length > 0) {
          setShowErrorSummary(true);
        }
        isStoppingRef.current = false;
        saveSessionToApi();
      },
      () => {
        recognizer.close();
        recognizerRef.current = null;
        setIsRecording(false);
        if (errorWordsRef.current.length > 0) {
          setShowErrorSummary(true);
        }
        isStoppingRef.current = false;
        saveSessionToApi();
      }
    );
  }, [finishVAD]);

  // ===== АВТОМАТИЧНЕ ЗАВЕРШЕННЯ =====
  useEffect(() => {
    const idx = currentIndexRef.current;
    if (idx >= REFERENCE_WORDS.length && isRecording && !isStoppingRef.current) {
      console.log('🎯 All words read, stopping automatically...');
      performStop();
    }
  }, [currentIndexRef.current, isRecording, performStop]);

  // Таймер підказок (тільки для повільного режиму)
  useEffect(() => {
    if (!isRecording) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    // Якщо швидкий режим - не використовуємо таймер підказок
    if (readingMode === "fast") {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    isInitializedRef.current = false;
    
    const initializationTimer = setTimeout(() => {
      isInitializedRef.current = true;
    }, 2000);

    timerRef.current = setInterval(() => {
      const currentStrategy = strategyRef.current;
      if (!currentStrategy) return;

      const idx = currentIndexRef.current;
      if (idx >= REFERENCE_WORDS.length) return;

      const currentWordStatus = wordsRef.current[idx]?.status;
      
      if (
        currentWordStatus === "correct" ||
        currentWordStatus === "self-corrected" ||
        currentWordStatus === "modelled" ||
        currentWordStatus === "skipped" ||
        currentWordStatus === "error"
      ) {
        advanceTo(idx + 1);
        return;
      }

      if (!isInitializedRef.current) {
        return;
      }

      const silence = Date.now() - lastActivityRef.current;

      if (promptedAtRef.current === null && silence >= currentStrategy.promptDelayMs) {
        promptedAtRef.current = Date.now();
        markWordStatus(idx, "prompted");
        setLiveHint(phonicsHint(REFERENCE_WORDS[idx]));
        logDecision({
          word: REFERENCE_WORDS[idx],
          action: "PROMPT",
          reason: `${(currentStrategy.promptDelayMs / 1000).toFixed(1)}s stall`,
        });
        return;
      }

      if (promptedAtRef.current !== null) {
        const modelReferenceTime = Math.max(promptedAtRef.current, lastActivityRef.current);

        if (
          Date.now() - modelReferenceTime >= currentStrategy.modelDelayMs &&
          modelledForIndexRef.current !== idx
        ) {
          modelledForIndexRef.current = idx;
          const word = REFERENCE_WORDS[idx];

          markWordStatus(idx, "modelled");
          logDecision({
            word,
            action: "MODEL",
            reason: "no response after prompt",
          });

          speakWord(word);
          advanceTo(idx + 1);
        }
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(initializationTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording, advanceTo, markWordStatus, logDecision, speakWord, readingMode]);

  // ===== ОБРОБКА РОЗПІЗНАНИХ СЛІВ =====
  const processRecognizedWords = useCallback((azureWords: AzureWordResult[]) => {
    if (processingLockRef.current || isStoppingRef.current) return;
    processingLockRef.current = true;

    try {
      touchActivity();

      const startIdx = currentIndexRef.current;
      if (startIdx >= REFERENCE_WORDS.length) {
        processingLockRef.current = false;
        return;
      }

      const filteredAzureWords = azureWords.filter(w => {
        const accuracy = w.PronunciationAssessment?.AccuracyScore ?? 0;
        return accuracy >= 20;
      });

      if (filteredAzureWords.length === 0) {
        processingLockRef.current = false;
        return;
      }

      // ===== ШВИДКИЙ РЕЖИМ: обробляємо всі слова в пакеті =====
      if (readingMode === "fast") {
        console.log('🚀 Fast Mode: processing all words:', filteredAzureWords.map(w => w.Word));
        
        let processedCount = 0;
        let currentIdx = startIdx;

        for (const azureWord of filteredAzureWords) {
          if (currentIdx >= REFERENCE_WORDS.length) break;
          
          const expectedWord = REFERENCE_WORDS[currentIdx].toLowerCase();
          const spokenWord = azureWord.Word.toLowerCase();
          const accuracy = azureWord.PronunciationAssessment?.AccuracyScore ?? 0;
          
          console.log(`Expected: "${expectedWord}", Spoken: "${spokenWord}", Accuracy: ${accuracy}`);
          
          // Перевіряємо матч
          if (spokenWord === expectedWord && accuracy > 50) {
            markWordStatus(currentIdx, "correct", accuracy);
            logDecision({
              word: expectedWord,
              action: "STAY_SILENT",
              reason: `accepted: "${azureWord.Word}" (${Math.round(accuracy)}%)`,
              accuracy: accuracy,
            });
            currentIdx++;
            processedCount++;
          } else if (accuracy > 60 && spokenWord.startsWith(expectedWord[0])) {
            markWordStatus(currentIdx, "correct", accuracy);
            logDecision({
              word: expectedWord,
              action: "STAY_SILENT",
              reason: `accepted: "${azureWord.Word}" (${Math.round(accuracy)}%)`,
              accuracy: accuracy,
            });
            currentIdx++;
            processedCount++;
          } else {
            // Якщо не матч - позначаємо як помилку
            markWordStatus(currentIdx, "error", accuracy);
            logDecision({
              word: expectedWord,
              action: "ERROR",
              reason: `heard "${azureWord.Word}" instead (${Math.round(accuracy)}%)`,
              accuracy: accuracy,
            });
            currentIdx++;
            processedCount++;
          }
        }

        // Якщо обробили хоч одне слово - переходимо на нову позицію
        if (processedCount > 0) {
          advanceTo(currentIdx);
        }
        
        processingLockRef.current = false;
        return;
      }

      // ===== ПОВІЛЬНИЙ РЕЖИМ: поточний (одне слово за раз) =====
      console.log('🐢 Slow Mode: processing one word at a time');
      
      const expectedWord = REFERENCE_WORDS[startIdx].toLowerCase();
      let foundMatch = false;
      let bestMatch = null;
      let bestAccuracy = 0;

      for (const azureWord of filteredAzureWords) {
        const spokenWord = azureWord.Word.toLowerCase();
        const accuracy = azureWord.PronunciationAssessment?.AccuracyScore ?? 0;
        
        console.log(`Expected: "${expectedWord}", Spoken: "${spokenWord}", Accuracy: ${accuracy}`);
        
        if (spokenWord === expectedWord && accuracy > 50) {
          bestMatch = azureWord;
          bestAccuracy = accuracy;
          foundMatch = true;
          break;
        }
        
        if (accuracy > 60 && spokenWord.startsWith(expectedWord[0])) {
          if (accuracy > bestAccuracy) {
            bestMatch = azureWord;
            bestAccuracy = accuracy;
            foundMatch = true;
          }
        }
      }

      if (foundMatch && bestMatch) {
        const wasPrompted = promptedAtRef.current !== null;
        const status: WordStatus = wasPrompted ? "self-corrected" : "correct";
        
        markWordStatus(startIdx, status, bestAccuracy);
        setCurrentSpokenWord(bestMatch.Word);
        
        logDecision({
          word: expectedWord,
          action: "STAY_SILENT",
          reason: wasPrompted ? "self-corrected after prompt" : `accepted: "${bestMatch.Word}" (${Math.round(bestAccuracy)}%)`,
          accuracy: bestAccuracy,
        });
        
        advanceTo(startIdx + 1);
      } else if (filteredAzureWords.length > 0) {
        const firstWord = filteredAzureWords[0];
        const firstWordText = firstWord.Word;
        const firstWordAccuracy = firstWord.PronunciationAssessment?.AccuracyScore ?? 0;
        
        if (firstWordAccuracy < 30) {
          markWordStatus(startIdx, "error", firstWordAccuracy);
          setCurrentSpokenWord(firstWordText);
          
          logDecision({
            word: expectedWord,
            action: "ERROR",
            reason: `poor pronunciation: "${firstWordText}" (${Math.round(firstWordAccuracy)}%)`,
            accuracy: firstWordAccuracy,
          });
          
          advanceTo(startIdx + 1);
        }
      }

    } catch (err) {
      console.error("Error processing words:", err);
    } finally {
      processingLockRef.current = false;
    }
  }, [touchActivity, markWordStatus, logDecision, advanceTo, readingMode]);

  // ===== ЗБЕРЕЖЕННЯ АУДІО В STORAGE =====
  const saveAudioToStorage = useCallback(async (sessionId: number, audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, `session_${sessionId}.webm`);
      
      const response = await fetch(`http://localhost:8000/api/sessions/${sessionId}/audio`, {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) throw new Error('Failed to upload audio');
      const data = await response.json();
      console.log('✅ Audio uploaded:', data.audio_url);
      return data.audio_url;
    } catch (error) {
      console.error('❌ Failed to upload audio:', error);
      return null;
    }
  }, []);

  // ===== ФУНКЦІЯ ЗБЕРЕЖЕННЯ СЕСІЇ (оновлена з аудіо) =====
  const saveSessionToApi = useCallback(async () => {
    try {
      const totalWords = REFERENCE_WORDS.length;
      const correctWords = wordsRef.current.filter(
        w => w.status === 'correct' || w.status === 'self-corrected'
      ).length;
      
      if (correctWords === 0) {
        console.log('⚠️ No correct words, skipping save');
        return;
      }
      
      const accuracy = totalWords > 0 ? Math.round((correctWords / totalWords) * 100) : 0;
      
      const durationMinutes = (Date.now() - startTimeRef.current) / 60000;
      const wpm = durationMinutes > 0 ? Math.round(totalWords / durationMinutes) : 0;
      
      const uniqueErrors = errorWordsRef.current.filter((word, index) => 
        errorWordsRef.current.indexOf(word) === index
      );
      
      const errors = uniqueErrors.map(word => ({
        word: word,
        type: 'substitution',
        expected: word,
        actual: 'unknown',
        confidence: 0.5
      }));
      
      const sessionData = {
        student_id: 1,
        story_id: 1,
        wpm: wpm,
        accuracy: accuracy,
        total_words: totalWords,
        correct_words: correctWords,
        errors: errors
      };
      
      console.log('📤 Sending session data:', sessionData);
      const result = await createSession(sessionData);
      console.log('✅ Session saved:', result);
      
      // ===== ЗБЕРІГАЄМО АУДІО =====
      // Отримуємо аудіо-блоб з useHesitationFSM
      if (getAudioBlob) {
        const audioBlob = getAudioBlob();
        if (audioBlob) {
          await saveAudioToStorage(result.id, audioBlob);
        }
      }
      
    } catch (error) {
      console.error('❌ Failed to save session:', error);
    }
  }, [getAudioBlob, saveAudioToStorage]);

  const startRecording = async () => {
    try {
      setError("");
      setDecisionTrace([]);
      errorWordsRef.current = [];
      setShowErrorSummary(false);
      setCurrentSpokenWord("");
      isStoppingRef.current = false;

      currentIndexRef.current = 0;
      promptedAtRef.current = null;
      modelledForIndexRef.current = null;
      processingLockRef.current = false;
      lastActivityRef.current = Date.now();
      startTimeRef.current = Date.now();
      isInitializedRef.current = false;
      lastSpokenWordRef.current = "";

      const freshWords = initialWords();
      commitWords(freshWords);
      setLiveHint("");

      await startVAD();

      const response = await fetch("/api/azure-speech-token", { method: "POST" });
      const data = await response.json();

      if (!response.ok || !data.token || !data.region) {
        throw new Error(`Failed to retrieve Azure Speech token (HTTP ${response.status})`);
      }

      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        data.token,
        data.region
      );

      const accent = student?.preferredAccent || "en-IE";
      speechConfig.speechRecognitionLanguage = accent;
      speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;

      const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
      recognizerRef.current = recognizer;

      const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
        REFERENCE_TEXT,
        SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
        SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
        true
      );
      pronunciationConfig.phonemeAlphabet = "IPA";
      pronunciationConfig.nbestPhonemeCount = 3;
      pronunciationConfig.applyTo(recognizer);

      recognizer.recognizing = (_sender, event) => {
        touchActivity();
        if (event.result.text) {
          setCurrentSpokenWord(event.result.text);
        }
      };

      recognizer.recognized = (_sender, event) => {
        touchActivity();
        if (event.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;

        const json = event.result.properties.getProperty(
          SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
        );

        let parsed: { NBest?: { Words?: AzureWordResult[] }[] } | null = null;
        try {
          parsed = JSON.parse(json);
        } catch {
          // JSON parse error
        }

        const azureWords = parsed?.NBest?.[0]?.Words ?? [];
        if (azureWords.length > 0) {
          console.log('🎤 Recognized words:', azureWords.map(w => ({ word: w.Word, accuracy: w.PronunciationAssessment?.AccuracyScore })));
          processRecognizedWords(azureWords);
        }
      };

      recognizer.canceled = (_sender, event) => {
        setError(event.errorDetails || `Recognition canceled: ${event.reason}`);
        setIsRecording(false);
      };

      recognizer.sessionStarted = () => {
        touchActivity();
        setIsRecording(true);
      };

      recognizer.sessionStopped = () => {
        setIsRecording(false);
        if (errorWordsRef.current.length > 0) {
          setShowErrorSummary(true);
        }
      };

      recognizer.startContinuousRecognitionAsync(
        () => {
          touchActivity();
          setIsRecording(true);
        },
        (startError) => {
          setError(String(startError));
          setIsRecording(false);
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    performStop();
  };

  const finished = currentIndexRef.current >= REFERENCE_WORDS.length;

  if (studentLoading) {
    return (
      <main className="rl-loading-page">
        <p>Loading student profile...</p>
      </main>
    );
  }

  return (
    <main className="rl-reader-page">
      <div className="rl-reader-wrap">
        <div className="rl-reader-header">
          <h1 className="rl-brand-lockup"><span className="rl-brand-mark" aria-hidden="true"><span /></span>Reader Leader</h1>
          <p className="rl-reader-meta">
            {student ? `${student.name} • ${student.age} years old` : "Read aloud together"}
          </p>
        </div>

        <section className="rl-session-card">
          <p className="rl-session-label">Read this</p>

          <p className="rl-reader-text">
            {words.map((w, i) => {
              let styleClass = "rl-word";

              if (w.status === "current") {
                styleClass = "rl-word rl-word-current";
              } else if (w.status === "prompted") {
                styleClass = "rl-word rl-word-prompted";
              } else if (w.status === "modelled") {
                styleClass = "rl-word rl-word-modelled";
              } else if (w.status === "skipped") {
                styleClass = "rl-word rl-word-skipped";
              } else if (w.status === "error") {
                styleClass = "rl-word rl-word-error";
              } else if (w.status === "correct" || w.status === "self-corrected") {
                styleClass = "rl-word rl-word-correct";
              }

              return (
                <span key={i} className={styleClass}>
                  {w.word}
                </span>
              );
            })}
          </p>

          {/* ===== ПЕРЕМИКАЧ РЕЖИМІВ ===== */}
          <div className="rl-mode-panel">
            <button
              onClick={() => setReadingMode("slow")}
              className={`rl-mode-button rl-mode-button--slow ${
                readingMode === "slow"
                  ? "is-active"
                  : ""
              }`}
              disabled={isRecording}
            >
              🐢 Slow Mode
            </button>
            <button
              onClick={() => setReadingMode("fast")}
              className={`rl-mode-button rl-mode-button--fast ${
                readingMode === "fast"
                  ? "is-active"
                  : ""
              }`}
              disabled={isRecording}
            >
              🚀 Fast Mode
            </button>
          </div>
          <p className="rl-mode-copy">
            {readingMode === "slow" 
              ? "🐢 One word at a time with prompts" 
              : "🚀 All words at once, no prompts"}
          </p>

          {isRecording && currentSpokenWord && (
            <p className="rl-recognition">
              🎤 Recognized: <strong>{currentSpokenWord}</strong>
            </p>
          )}

          {liveHint && <p className="rl-hint">Try: {liveHint}</p>}

          <div className="rl-action-row">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="rl-record-button"
              >
                🎤 Start Reading
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="rl-record-button rl-record-button--stop"
              >
                ■ Stop
              </button>
            )}
          </div>

          {isRecording && !finished && (
            <p className="rl-listening">
              {currentSpokenWord ? '🎤 Analyzing...' : '🎤 Listening... Speak clearly!'}
            </p>
          )}

          {finished && (
            <p className="rl-finished">Finished reading 🎉</p>
          )}
        </section>

        <section className="rl-teacher-section">
          <button
            onClick={() => setShowTeacherView((v) => !v)}
            className="rl-teacher-toggle"
          >
            {showTeacherView ? "Hide" : "Show"} decision trace (teacher view)
          </button>

          {showTeacherView && (
            <div className="rl-teacher-card">
              <p className="rl-teacher-title">Live decision trace</p>

              {decisionTrace.length === 0 ? (
                <p className="rl-empty-trace">No decisions yet.</p>
              ) : (
                <div className="rl-trace-list">
                  {decisionTrace.map((d, i) => (
                    <div
                      key={i}
                      className="rl-trace-row"
                    >
                      <span className="rl-trace-word">{d.word}</span>
                      <span
                        className={
                          d.action === "STAY_SILENT"
                            ? "rl-trace-action rl-action-success"
                            : d.action === "WAIT"
                            ? "rl-trace-action rl-action-wait"
                            : d.action === "PROMPT"
                            ? "rl-trace-action rl-action-prompt"
                            : d.action === "MODEL"
                            ? "rl-trace-action rl-action-model"
                            : d.action === "ERROR"
                            ? "rl-trace-action rl-action-error"
                            : "rl-trace-action rl-action-wait"
                        }
                      >
                        {d.action}
                      </span>
                      <span className="rl-trace-reason">{d.reason}</span>
                      <span className="rl-trace-score">
                        {d.accuracy !== undefined ? d.accuracy.toFixed(0) : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
