'use client';

import { useEffect, useState } from 'react';
import { getDashboard, getStudentAnalytics, getStudentRecommendations, Student, StudentAnalytics, Recommendations } from '@/lib/api';

export default function DashboardPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [analytics, setAnalytics] = useState<StudentAnalytics | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);

  // Завантаження списку студентів
  useEffect(() => {
    async function loadStudents() {
      try {
        const data = await getDashboard();
        setStudents(data.students);
        if (data.students.length > 0) {
          setSelectedStudent(data.students[0]);
        }
      } catch (err) {
        setError('Failed to load students');
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadStudents();
  }, []);

  // Завантаження аналітики при виборі студента
  useEffect(() => {
    if (!selectedStudent) return;

    async function loadAnalytics() {
      try {
        setAudioUrl(null);
        setAudioLoading(true);
        
        const [analyticsData, recData] = await Promise.all([
          getStudentAnalytics(selectedStudent.id),
          getStudentRecommendations(selectedStudent.id),
        ]);
        setAnalytics(analyticsData);
        setRecommendations(recData);
        
        // Отримуємо аудіо з останньої сесії (якщо є)
        if (analyticsData.last_session_audio_url) {
          setAudioUrl(analyticsData.last_session_audio_url);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setAudioLoading(false);
      }
    }
    loadAnalytics();
  }, [selectedStudent]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">📚 Reading Analytics</h1>
        <p className="text-gray-500 mb-8">Teacher Dashboard — select a student to view details</p>

        {/* Список студентів */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {students.map((student) => (
            <div
              key={student.id}
              onClick={() => setSelectedStudent(student)}
              className={`bg-white rounded-xl p-5 shadow-sm cursor-pointer transition-all hover:shadow-md border-2 ${
                selectedStudent?.id === student.id ? 'border-blue-500 bg-blue-50' : 'border-transparent'
              }`}
            >
              <div className="font-semibold text-lg">{student.name}</div>
              <div className="text-sm text-gray-500">
                {student.last_session_date
                  ? new Date(student.last_session_date).toLocaleDateString()
                  : 'No sessions'}
              </div>
              <div className="mt-2">
                <span
                  className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                    student.needs_attention
                      ? 'bg-red-100 text-red-700'
                      : student.wpm
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {student.needs_attention
                    ? '⚠️ Needs attention'
                    : student.wpm
                    ? `✅ ${student.wpm} WPM`
                    : 'No sessions'}
                </span>
                <span className="ml-2 text-gray-400">
                  {student.progress === '↑' ? '📈' : student.progress === '↓' ? '📉' : '➖'}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Аналітика */}
        {analytics && selectedStudent && (
          <div className="bg-white rounded-2xl p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-semibold">{analytics.student_name}</h2>
              <span className="text-sm text-gray-500">
                {analytics.last_session_date
                  ? `Last session: ${new Date(analytics.last_session_date).toLocaleDateString()}`
                  : 'No sessions'}
              </span>
            </div>

            {/* Статистика */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-gray-900">{analytics.progress.average_wpm}</div>
                <div className="text-sm text-gray-500">Avg WPM</div>
                <div className={`text-sm font-medium ${analytics.progress.wpm_trend > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {analytics.progress.wpm_trend > 0 ? `↑ +${analytics.progress.wpm_trend}%` : '➖ 0%'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-gray-900">{analytics.progress.average_accuracy}%</div>
                <div className="text-sm text-gray-500">Accuracy</div>
                <div className={`text-sm font-medium ${analytics.progress.accuracy_trend > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {analytics.progress.accuracy_trend > 0 ? `↑ +${analytics.progress.accuracy_trend}%` : '➖ 0%'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-xl p-4 text-center">
                <div className="text-3xl font-bold text-gray-900">{analytics.progress.total_sessions}</div>
                <div className="text-sm text-gray-500">Total Sessions</div>
              </div>
            </div>

            {/* ===== АУДІО-ПЛЕЄР (НОВИЙ БЛОК) ===== */}
            {audioLoading ? (
              <div className="mb-6 p-4 bg-gray-50 rounded-xl text-center text-gray-500 text-sm">
                Loading audio...
              </div>
            ) : audioUrl ? (
              <div className="mb-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
                <p className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                  🎧 Recording
                  <span className="text-xs text-gray-400 font-normal">(last session)</span>
                </p>
                <audio controls className="w-full max-w-md">
                  <source src={audioUrl} type="audio/webm" />
                  <source src={audioUrl} type="audio/mp3" />
                  <source src={audioUrl} type="audio/wav" />
                  Your browser does not support the audio element.
                </audio>
                <p className="text-xs text-gray-400 mt-1 truncate">{audioUrl}</p>
              </div>
            ) : (
              <div className="mb-6 p-4 bg-gray-50 rounded-xl text-center text-gray-400 text-sm border border-dashed border-gray-300">
                🎙️ No recording available for this student
              </div>
            )}

            {/* Помилки та складні слова */}
            <div className="grid grid-cols-2 gap-6 mb-6">
              <div>
                <h3 className="font-semibold text-gray-700 mb-3">⚠️ Frequent Errors</h3>
                <ul className="space-y-2">
                  {analytics.frequent_errors.length > 0 ? (
                    analytics.frequent_errors.map((e) => (
                      <li key={e.error_type} className="flex justify-between bg-gray-50 px-4 py-2 rounded-lg">
                        <span>{e.error_type}</span>
                        <span className="bg-gray-200 px-3 py-0.5 rounded-full text-sm font-medium">{e.count}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-gray-400">No errors 🎉</li>
                  )}
                </ul>
              </div>
              <div>
                <h3 className="font-semibold text-gray-700 mb-3">🔤 Difficult Words</h3>
                <ul className="space-y-2">
                  {analytics.difficult_words.length > 0 ? (
                    analytics.difficult_words.map((w) => (
                      <li key={w.word} className="flex justify-between bg-gray-50 px-4 py-2 rounded-lg">
                        <span>{w.word}</span>
                        <span className="bg-gray-200 px-3 py-0.5 rounded-full text-sm font-medium">{w.count}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-gray-400">No difficult words 🎉</li>
                  )}
                </ul>
              </div>
            </div>

            {/* Рекомендації */}
            {recommendations && (
              <div className="bg-blue-50 rounded-xl p-5 border-l-4 border-blue-500">
                <h3 className="font-semibold text-gray-700 mb-3">💡 Teacher Recommendations</h3>
                <ul className="space-y-1 mb-4">
                  {recommendations.recommendations.map((r, i) => (
                    <li key={i} className="text-gray-700">• {r}</li>
                  ))}
                </ul>
                <div>
                  <strong>Practice Words:</strong>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {recommendations.practice_words.map((w) => (
                      <span key={w} className="bg-blue-200 px-4 py-1 rounded-full text-sm font-medium text-blue-800">
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="mt-3 text-sm text-gray-600">
                  <strong>Next Difficulty:</strong> {recommendations.next_story_difficulty}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}