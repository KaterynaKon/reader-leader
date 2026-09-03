"use client";

import { useEffect, useRef, useState } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";

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

// ----------------------------------------------------------------------
// CONFIG
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

function normalise(word: string) {
  return word.toLowerCase().replace(/[.,!?]/g, "").trim();
}

function phonicsHint(word: string) {
  return word.length > 0 ? `${word[0]}...` : "";
}

function initialWords(): WordState[] {
  return REFERENCE_WORDS.map((word, i) => ({
    word,
    status: i === 0 ? "current" : "waiting",
  }));
}

// ----------------------------------------------------------------------
// СТРАТЕГІЇ КОРЕКЦІЇ (оновлені пороги)
// ----------------------------------------------------------------------

const getCorrectionStrategy = (level: ReadingLevel): CorrectionStrategy => {
  switch (level) {
    case "beginner":
      return {
        checkRate: 1.0,
        promptDelayMs: 2500,
        modelDelayMs: 2500,
        minAccuracy: 40,
        checkAllShortTexts: true,
      };
    case "intermediate":
      return {
        checkRate: 0.7,
        promptDelayMs: 2500,
        modelDelayMs: 2500,
        minAccuracy: 45,
        checkAllShortTexts: true,
      };
    case "advanced":
      return {
        checkRate: 0.5,
        promptDelayMs: 2000,
        modelDelayMs: 2000,
        minAccuracy: 50,
        checkAllShortTexts: false,
      };
    default:
      return {
        checkRate: 0.7,
        promptDelayMs: 2500,
        modelDelayMs: 2500,
        minAccuracy: 45,
        checkAllShortTexts: true,
      };
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

  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [strategy, setStrategy] = useState<CorrectionStrategy | null>(null);
  const [studentLoading, setStudentLoading] = useState(true);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState("");
  const [words, setWords] = useState<WordState[]>(wordsRef.current);
  const [decisionTrace, setDecisionTrace] = useState<DecisionRecord[]>([]);
  const [liveHint, setLiveHint] = useState("");
  const [showTeacherView, setShowTeacherView] = useState(false);
  const [showErrorSummary, setShowErrorSummary] = useState(false);

  // --------------------------------------------------------------------
  // ЗАВАНТАЖЕННЯ СТУДЕНТА
  // --------------------------------------------------------------------

  useEffect(() => {
    const loadStudent = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const studentId = params.get("student");

        if (studentId) {
          const levelParam = params.get("level") as ReadingLevel | null;
          const studentData = {
            ...TEST_STUDENT,
            id: studentId,
            readingLevel: levelParam || TEST_STUDENT.readingLevel,
          };
          setStudent(studentData);
          setStrategy(getCorrectionStrategy(studentData.readingLevel));
        } else {
          setStudent(TEST_STUDENT);
          setStrategy(getCorrectionStrategy(TEST_STUDENT.readingLevel));
        }
      } catch (err) {
        console.error("Failed to load student:", err);
        setStudent(TEST_STUDENT);
        setStrategy(getCorrectionStrategy(TEST_STUDENT.readingLevel));
      } finally {
        setStudentLoading(false);
      }
    };

    loadStudent();
  }, []);

  // --------------------------------------------------------------------
  // ГОЛОСОВІ РУШІЇ
  // --------------------------------------------------------------------

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  const speakWord = (word: string) => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      const voices = voicesRef.current;

      const preferred =
        voices.find((v) => v.lang === "en-GB") ||
        voices.find((v) => v.lang === "en-IE") ||
        voices.find((v) => v.lang.startsWith("en"));

      if (preferred) {
        utterance.voice = preferred;
        utterance.lang = preferred.lang;
      } else {
        utterance.lang = "en-GB";
      }

      utterance.rate = 0.85;
      window.speechSynthesis.speak(utterance);
    } catch {
      // speechSynthesis not available
    }
  };

  // --------------------------------------------------------------------
  // ДОПОМІЖНІ ФУНКЦІЇ
  // --------------------------------------------------------------------

  const commitWords = (next: WordState[]) => {
    wordsRef.current = next;
    setWords(next);
  };

  const logDecision = (record: Omit<DecisionRecord, "timestamp">) => {
    setDecisionTrace((prev) => [...prev, { ...record, timestamp: Date.now() }]);
  };

  const touchActivity = () => {
    lastActivityRef.current = Date.now();
    if (promptedAtRef.current !== null) {
      promptedAtRef.current = null;
    }
  };

  const advanceTo = (index: number) => {
    if (index <= currentIndexRef.current) return;
    
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
  };

  const markWordStatus = (index: number, status: WordStatus, accuracy?: number) => {
    if (status === "error" || status === "modelled") {
      const word = REFERENCE_WORDS[index];
      if (!errorWordsRef.current.includes(word)) {
        errorWordsRef.current.push(word);
      }
    }
    
    commitWords(
      wordsRef.current.map((w, i) => (i === index ? { ...w, status, accuracy } : w))
    );
  };

  // --------------------------------------------------------------------
  // АДАПТИВНА ЛОГІКА
  // --------------------------------------------------------------------

  const shouldCheckWord = (
    wordIndex: number,
    totalWords: number,
    strat: CorrectionStrategy,
    avgAccuracy: number,
    wordsRead: number
  ): boolean => {
    if (totalWords <= 10 && strat.checkAllShortTexts) {
      return true;
    }

    if (avgAccuracy < strat.minAccuracy && wordsRead > 3) {
      return true;
    }

    if (wordIndex === 0) return true;

    const seed = wordIndex * 7 + 13;
    const random = ((seed * 9301 + 49297) % 233280) / 233280;
    return random < strat.checkRate;
  };

  // --------------------------------------------------------------------
  // ОБРОБКА РОЗПІЗНАНИХ СЛІВ (оновлена)
  // --------------------------------------------------------------------

  const processRecognizedWords = (
    azureWords: { Word: string; AccuracyScore: number }[],
    isInterim: boolean = false
  ) => {
    if (processingLockRef.current) return;
    if (!strategy) return;
    if (currentIndexRef.current >= REFERENCE_WORDS.length) return;

    processingLockRef.current = true;

    try {
      const currentIdx = currentIndexRef.current;
      const expected = normalise(REFERENCE_WORDS[currentIdx]);
      
      const firstWord = azureWords[0];
      if (!firstWord) {
        processingLockRef.current = false;
        return;
      }

      const heard = normalise(firstWord.Word);
      const accuracy = firstWord.AccuracyScore ?? 0;

      if (isInterim) {
        touchActivity();
        processingLockRef.current = false;
        return;
      }

      touchActivity();

      const currentStatus = wordsRef.current[currentIdx]?.status;
      if (currentStatus === "correct" || 
          currentStatus === "self-corrected" || 
          currentStatus === "modelled" ||
          currentStatus === "error") {
        advanceTo(currentIdx + 1);
        processingLockRef.current = false;
        return;
      }

      const totalWordsRead = wordsRef.current.filter(
        (w) => w.status === "correct" || w.status === "self-corrected"
      ).length;

      const accuracySum = wordsRef.current
        .filter((w) => w.accuracy !== undefined)
        .reduce((sum, w) => sum + (w.accuracy || 0), 0);

      const avgAccuracy = accuracySum / (totalWordsRead || 1);
      const totalWords = REFERENCE_WORDS.length;

      const shouldCheck = shouldCheckWord(
        currentIdx,
        totalWords,
        strategy,
        avgAccuracy,
        totalWordsRead
      );

      if (!shouldCheck) {
        markWordStatus(currentIdx, "skipped", accuracy);
        logDecision({
          word: REFERENCE_WORDS[currentIdx],
          action: "SKIPPED",
          reason: `adaptive skip (checkRate: ${strategy.checkRate})`,
          accuracy,
        });
        advanceTo(currentIdx + 1);
        processingLockRef.current = false;
        return;
      }

      const wasPrompted = promptedAtRef.current !== null;
      const wordsMatch = heard === expected;

      // 🔥 НОВА ЛОГІКА: приймаємо, якщо слова збігаються і точність > 30
      if (wordsMatch && accuracy >= 30) {
        if (wasPrompted) {
          markWordStatus(currentIdx, "self-corrected", accuracy);
          logDecision({
            word: REFERENCE_WORDS[currentIdx],
            action: "STAY_SILENT",
            reason: "self-corrected after prompt",
            accuracy,
          });
        } else {
          markWordStatus(currentIdx, "correct", accuracy);
          logDecision({
            word: REFERENCE_WORDS[currentIdx],
            action: "STAY_SILENT",
            reason: "accepted reading",
            accuracy,
          });
        }
        promptedAtRef.current = null;
        advanceTo(currentIdx + 1);
      } else if (wordsMatch && accuracy < 30) {
        // Дуже низька точність — чекаємо
        logDecision({
          word: REFERENCE_WORDS[currentIdx],
          action: "WAIT",
          reason: `very low confidence (${accuracy.toFixed(0)})`,
          accuracy,
        });
      } else {
        // Слова не збігаються — помилка
        markWordStatus(currentIdx, "error", accuracy);
        logDecision({
          word: REFERENCE_WORDS[currentIdx],
          action: "ERROR",
          reason: `heard "${firstWord.Word}" instead of "${REFERENCE_WORDS[currentIdx]}"`,
          accuracy,
        });
        promptedAtRef.current = null;
        advanceTo(currentIdx + 1);
      }

    } catch (err) {
      console.error("Process error:", err);
    } finally {
      setTimeout(() => {
        processingLockRef.current = false;
      }, 100);
    }
  };

  // --------------------------------------------------------------------
  // ТАЙМЕР
  // --------------------------------------------------------------------

  useEffect(() => {
    if (!isRecording || !strategy) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      const idx = currentIndexRef.current;
      if (idx >= REFERENCE_WORDS.length) return;

      const currentWordStatus = wordsRef.current[idx]?.status;
      if (currentWordStatus === "correct" || 
          currentWordStatus === "self-corrected" || 
          currentWordStatus === "modelled" ||
          currentWordStatus === "skipped" ||
          currentWordStatus === "error") {
        advanceTo(idx + 1);
        return;
      }

      const silence = Date.now() - lastActivityRef.current;

      if (promptedAtRef.current === null && silence >= strategy.promptDelayMs) {
        promptedAtRef.current = Date.now();
        markWordStatus(idx, "prompted");
        setLiveHint(phonicsHint(REFERENCE_WORDS[idx]));
        logDecision({
          word: REFERENCE_WORDS[idx],
          action: "PROMPT",
          reason: `${(strategy.promptDelayMs / 1000).toFixed(0)}s stall`,
        });
        return;
      }

      if (promptedAtRef.current !== null) {
        const modelReferenceTime = Math.max(
          promptedAtRef.current,
          lastActivityRef.current
        );

        if (
          Date.now() - modelReferenceTime >= strategy.modelDelayMs &&
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
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording, strategy]);

  // --------------------------------------------------------------------
  // START / STOP
  // --------------------------------------------------------------------

  const startRecording = async () => {
    try {
      setError("");
      setDecisionTrace([]);
      errorWordsRef.current = [];
      setShowErrorSummary(false);
      
      currentIndexRef.current = 0;
      promptedAtRef.current = null;
      modelledForIndexRef.current = null;
      processingLockRef.current = false;
      lastActivityRef.current = Date.now();
      commitWords(initialWords());
      setLiveHint("");

      const response = await fetch("/api/azure-speech-token", { method: "POST" });
      const data = await response.json();

      if (!response.ok || !data.token || !data.region) {
        throw new Error(`Could not get Azure Speech token. HTTP ${response.status}`);
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
      };

      recognizer.recognized = (_sender, event) => {
        if (event.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) {
          touchActivity();
          return;
        }

        const json = event.result.properties.getProperty(
          SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
        );

        let parsed: any = null;
        try {
          parsed = JSON.parse(json);
        } catch {
          // ignore
        }

        const azureWords = parsed?.NBest?.[0]?.Words ?? [];

        const simplified = azureWords.map((w: any) => ({
          Word: w.Word ?? "",
          AccuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
        }));

        if (simplified.length > 0) {
          processRecognizedWords(simplified, false);
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
    const recognizer = recognizerRef.current;
    if (!recognizer) return;

    recognizer.stopContinuousRecognitionAsync(
      () => {
        recognizer.close();
        recognizerRef.current = null;
        setIsRecording(false);
        if (errorWordsRef.current.length > 0) {
          setShowErrorSummary(true);
        }
      },
      () => {
        recognizer.close();
        recognizerRef.current = null;
        setIsRecording(false);
        if (errorWordsRef.current.length > 0) {
          setShowErrorSummary(true);
        }
      }
    );
  };

  const finished = currentIndexRef.current >= REFERENCE_WORDS.length;

  // --------------------------------------------------------------------
  // UI
  // --------------------------------------------------------------------

  if (studentLoading) {
    return (
      <main className="min-h-screen bg-gray-50 px-6 py-12 flex items-center justify-center">
        <p className="text-gray-500">Loading student profile...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 px-6 py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-semibold text-gray-900">Reader Leader</h1>
          <p className="mt-2 text-sm text-gray-500">
            {student ? `${student.name} • ${student.age} years old` : "Read aloud together"}
          </p>
          {strategy && (
            <div className="mt-2 text-xs text-gray-400">
              Level:{" "}
              <span
                className={
                  student?.readingLevel === "beginner"
                    ? "text-orange-500"
                    : student?.readingLevel === "intermediate"
                    ? "text-blue-500"
                    : "text-green-500"
                }
              >
                {student?.readingLevel === "beginner"
                  ? "📖 Beginner (check all words)"
                  : student?.readingLevel === "intermediate"
                  ? "📚 Intermediate (check ~70%)"
                  : "🚀 Advanced (check ~50%)"}
              </span>
            </div>
          )}
        </div>

        {/* CHILD VIEW */}
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <p className="mb-6 text-sm text-gray-500">Read this:</p>

          <p className="flex flex-wrap gap-x-3 gap-y-2 text-3xl font-medium leading-relaxed">
            {words.map((w, i) => (
              <span
                key={i}
                className={
                  w.status === "current"
                    ? "rounded bg-yellow-100 px-1 text-gray-900"
                    : w.status === "prompted"
                    ? "rounded bg-orange-100 px-1 text-gray-900"
                    : w.status === "modelled"
                    ? "rounded bg-blue-100 px-1 text-gray-900"
                    : w.status === "skipped"
                    ? "text-gray-300 line-through"
                    : w.status === "error"
                    ? "rounded bg-red-200 px-1 text-gray-900"
                    : w.status === "correct" || w.status === "self-corrected"
                    ? "text-gray-400"
                    : "text-gray-900"
                }
              >
                {w.word}
              </span>
            ))}
          </p>

          {liveHint && <p className="mt-4 text-lg text-orange-600">Try: {liveHint}</p>}

          <div className="mt-8 text-center">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="rounded-full bg-gray-900 px-8 py-4 text-lg font-medium text-white transition hover:bg-gray-800"
              >
                🎤 Start Reading
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="rounded-full bg-red-600 px-8 py-4 text-lg font-medium text-white transition hover:bg-red-700"
              >
                ■ Stop
              </button>
            )}
          </div>

          {isRecording && !finished && (
            <p className="mt-5 text-center text-sm text-gray-500">
              Listening
              {strategy && strategy.checkRate < 1
                ? ` (checking ~${Math.round(strategy.checkRate * 100)}% of words)`
                : " (checking all words)"}
              ...
            </p>
          )}

          {finished && (
            <p className="mt-5 text-center text-sm text-green-600">Finished reading 🎉</p>
          )}
        </section>

        {/* ERROR SUMMARY */}
        {showErrorSummary && errorWordsRef.current.length > 0 && (
          <section className="mt-6 rounded-2xl bg-red-50 p-6">
            <h3 className="text-lg font-semibold text-red-700">📝 Words to practice</h3>
            <p className="mt-1 text-sm text-red-600">
              Here are the words you missed. Try reading them again:
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {errorWordsRef.current.map((word, i) => (
                <span
                  key={i}
                  className="rounded-full bg-red-100 px-4 py-2 text-lg font-medium text-red-700 cursor-pointer hover:bg-red-200"
                  onClick={() => speakWord(word)}
                >
                  {word} 🔊
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-red-500">Click a word to hear it.</p>
          </section>
        )}

        {error && (
          <section className="mt-6 rounded-2xl bg-red-50 p-5">
            <p className="font-medium text-red-700">Error</p>
            <p className="mt-2 text-sm text-red-600">{error}</p>
          </section>
        )}

        {/* TEACHER VIEW */}
        <section className="mt-6">
          <button
            onClick={() => setShowTeacherView((v) => !v)}
            className="text-sm text-gray-500 underline"
          >
            {showTeacherView ? "Hide" : "Show"} decision trace (teacher view)
          </button>

          {showTeacherView && (
            <div className="mt-4 rounded-2xl bg-white p-6 shadow-sm">
              <p className="mb-4 text-sm font-medium text-gray-700">Live decision trace</p>

              {decisionTrace.length === 0 ? (
                <p className="text-sm text-gray-400">No decisions yet.</p>
              ) : (
                <div className="max-h-96 space-y-2 overflow-y-auto">
                  {decisionTrace.map((d, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between border-b border-gray-100 pb-2 text-sm"
                    >
                      <span className="font-medium text-gray-900">{d.word}</span>
                      <span
                        className={
                          d.action === "STAY_SILENT"
                            ? "text-green-600"
                            : d.action === "WAIT"
                            ? "text-gray-400"
                            : d.action === "PROMPT"
                            ? "text-orange-600"
                            : d.action === "MODEL"
                            ? "text-blue-600"
                            : d.action === "ERROR"
                            ? "text-red-600"
                            : "text-gray-400"
                        }
                      >
                        {d.action}
                      </span>
                      <span className="text-gray-500">{d.reason}</span>
                      <span className="text-gray-400">
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