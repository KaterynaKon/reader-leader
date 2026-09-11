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
    const studentId = selectedStudent?.id;
    if (studentId === undefined) return;

    async function loadAnalytics() {
      try {
        setAudioUrl(null);
        setAudioLoading(true);
        
        const [analyticsData, recData] = await Promise.all([
          getStudentAnalytics(studentId!),
          getStudentRecommendations(studentId!),
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
      <div className="rl-loading-page">
        <p>Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rl-error-page">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="rl-dashboard">
      <div className="rl-dashboard-wrap">
        <p className="rl-dashboard-kicker">Reader Leader · teacher space</p>
        <h1 className="rl-dashboard-title">Reading Analytics</h1>
        <p className="rl-dashboard-subtitle">Teacher Dashboard — select a student to view details</p>

        {/* Список студентів */}
        <div className="rl-student-grid">
          {students.map((student) => (
            <div
              key={student.id}
              onClick={() => setSelectedStudent(student)}
              className={`rl-student-card ${
                selectedStudent?.id === student.id ? 'is-selected' : ''
              }`}
            >
              <div className="rl-student-name">{student.name}</div>
              <div className="rl-student-date">
                {student.last_session_date
                  ? new Date(student.last_session_date).toLocaleDateString()
                  : 'No sessions'}
              </div>
              <div className="rl-student-status-row">
                <span
                  className={`rl-status-pill ${
                    student.needs_attention
                      ? 'rl-status-pill--attention'
                      : student.wpm
                      ? 'rl-status-pill--active'
                      : 'rl-status-pill--empty'
                  }`}
                >
                  {student.needs_attention
                    ? '⚠️ Needs attention'
                    : student.wpm
                    ? `✅ ${student.wpm} WPM`
                    : 'No sessions'}
                </span>
                <span className="rl-progress-arrow">
                  {student.progress === '↑' ? '📈' : student.progress === '↓' ? '📉' : '➖'}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Аналітика */}
        {analytics && selectedStudent && (
          <div className="rl-analytics-card">
            <div className="rl-analytics-head">
              <h2 className="rl-analytics-title">{analytics.student_name}</h2>
              <p className="rl-analytics-date">
                {analytics.last_session_date
                  ? `Last session: ${new Date(analytics.last_session_date).toLocaleDateString()}`
                  : 'No sessions'}
              </p>
            </div>

            {/* Статистика */}
            <div className="rl-stat-grid">
              <div className="rl-stat-card">
                <div className="rl-stat-value">{analytics.progress.average_wpm}</div>
                <div className="rl-stat-label">Avg WPM</div>
                <div className={`rl-stat-trend ${analytics.progress.wpm_trend > 0 ? 'rl-trend-positive' : 'rl-trend-negative'}`}>
                  {analytics.progress.wpm_trend > 0 ? `↑ +${analytics.progress.wpm_trend}%` : '➖ 0%'}
                </div>
              </div>
              <div className="rl-stat-card">
                <div className="rl-stat-value">{analytics.progress.average_accuracy}%</div>
                <div className="rl-stat-label">Accuracy</div>
                <div className={`rl-stat-trend ${analytics.progress.accuracy_trend > 0 ? 'rl-trend-positive' : 'rl-trend-negative'}`}>
                  {analytics.progress.accuracy_trend > 0 ? `↑ +${analytics.progress.accuracy_trend}%` : '➖ 0%'}
                </div>
              </div>
              <div className="rl-stat-card">
                <div className="rl-stat-value">{analytics.progress.total_sessions}</div>
                <div className="rl-stat-label">Total Sessions</div>
              </div>
            </div>

            {/* ===== АУДІО-ПЛЕЄР (НОВИЙ БЛОК) ===== */}
            {audioLoading ? (
              <div className="rl-empty-audio">
                Loading audio...
              </div>
            ) : audioUrl ? (
              <div className="rl-audio-panel">
                <p className="rl-audio-title">
                  🎧 Recording
                  <small> (last session)</small>
                </p>
                <audio controls className="rl-audio-player">
                  <source src={audioUrl} type="audio/webm" />
                  <source src={audioUrl} type="audio/mp3" />
                  <source src={audioUrl} type="audio/wav" />
                  Your browser does not support the audio element.
                </audio>
                <p className="rl-audio-url">{audioUrl}</p>
              </div>
            ) : (
              <div className="rl-empty-audio">
                🎙️ No recording available for this student
              </div>
            )}

            {/* Помилки та складні слова */}
            <div className="rl-details-grid">
              <div>
                <h3 className="rl-details-title">⚠️ Frequent Errors</h3>
                <ul className="rl-details-list">
                  {analytics.frequent_errors.length > 0 ? (
                    analytics.frequent_errors.map((e) => (
                      <li key={e.error_type}>
                        <span>{e.error_type}</span>
                        <span className="rl-count-pill">{e.count}</span>
                      </li>
                    ))
                  ) : (
                    <li className="rl-details-empty">No errors 🎉</li>
                  )}
                </ul>
              </div>
              <div>
                <h3 className="rl-details-title">🔤 Difficult Words</h3>
                <ul className="rl-details-list">
                  {analytics.difficult_words.length > 0 ? (
                    analytics.difficult_words.map((w) => (
                      <li key={w.word}>
                        <span>{w.word}</span>
                        <span className="rl-count-pill">{w.count}</span>
                      </li>
                    ))
                  ) : (
                    <li className="rl-details-empty">No difficult words 🎉</li>
                  )}
                </ul>
              </div>
            </div>

            {/* Рекомендації */}
            {recommendations && (
              <div className="rl-recommendations">
                <h3 className="rl-recommendations-title">💡 Teacher Recommendations</h3>
                <ul className="rl-recommendations-list">
                  {recommendations.recommendations.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
                <div className="rl-practice-label">
                  <strong>Practice Words:</strong>
                  <div className="rl-word-pills">
                    {recommendations.practice_words.map((w) => (
                      <span key={w} className="rl-word-pill">
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rl-next-difficulty">
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
