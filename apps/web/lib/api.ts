const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type QuestionType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'SELECT'
  | 'MULTI_SELECT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'DATE'
  | 'IMAGE';

export type QuestionOption = {
  key: string;
  label: string;
};

export type Question = {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: QuestionType;
  isRequired: boolean;
  options: QuestionOption[] | null;
  sortOrder: number;
};

export type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  questions?: Question[];
};

export async function apiFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}
