const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api';

export interface Student {
  id: number;
  name: string;
  last_session_date: string | null;
  wpm: number | null;
  accuracy: number | null;
  progress: string;
  needs_attention: boolean;
}

export interface ErrorItem {
  id: number;
  word: string;
  error_type: string;
  expected: string | null;
  actual: string | null;
}

export interface Session {
  id: number;
  student_id: number;
  story_id: number | null;
  wpm: number;
  accuracy: number;
  error_count: number;
  created_at: string | null;
  errors: ErrorItem[];
}

export interface ProgressMetrics {
  wpm_trend: number;
  accuracy_trend: number;
  total_sessions: number;
  average_wpm: number;
  average_accuracy: number;
}

export interface FrequentError {
  error_type: string;
  count: number;
}

export interface StudentAnalytics {
  student_id: number;
  student_name: string;
  progress: ProgressMetrics;
  frequent_errors: FrequentError[];
  difficult_words: { word: string; count: number }[];
  last_session_date: string | null;
}

export interface Recommendations {
  student_id: number;
  student_name: string;
  recommendations: string[];
  practice_words: string[];
  next_story_difficulty: string;
}

export interface DashboardResponse {
  students: Student[];
}

// ===== API Functions =====

export async function getDashboard(): Promise<DashboardResponse> {
  const res = await fetch(`${API_BASE}/teacher/dashboard`);
  if (!res.ok) throw new Error('Failed to fetch dashboard');
  return res.json();
}

export async function getStudentSessions(studentId: number): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/students/${studentId}/sessions`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function getStudentAnalytics(studentId: number): Promise<StudentAnalytics> {
  const res = await fetch(`${API_BASE}/students/${studentId}/analytics`);
  if (!res.ok) throw new Error('Failed to fetch analytics');
  return res.json();
}

export async function getStudentRecommendations(studentId: number): Promise<Recommendations> {
  const res = await fetch(`${API_BASE}/students/${studentId}/recommendations`);
  if (!res.ok) throw new Error('Failed to fetch recommendations');
  return res.json();
}

export async function createSession(data: {
  student_id: number;
  story_id?: number;
  wpm: number;
  accuracy: number;
  total_words: number;
  correct_words: number;
  errors: {
    word: string;
    type: string;
    expected?: string;
    actual?: string;
    confidence?: number;
    duration?: number;
    position?: number;
  }[];
}): Promise<Session> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}