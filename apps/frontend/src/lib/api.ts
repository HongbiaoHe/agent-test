import { getSession } from "next-auth/react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 统一请求：从 next-auth session 取 backendToken 带 Authorization；解析 {code,message,data}。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const session = (await getSession()) as { backendToken?: string } | null;
  const token = session?.backendToken;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as ApiEnvelope<T>;
  if (body.code !== 0) {
    throw new Error(body.message || `请求失败 (${res.status})`);
  }
  return body.data;
}

export interface ConversationMessage {
  id: string;
  role: string;
  type: string;
  content: unknown;
  seq: number;
}

export interface Conversation {
  id: string;
  goal: string;
  status: string;
  messages: ConversationMessage[];
}

export function createConversation(
  goal: string,
): Promise<{ conversationId: string }> {
  return request("/conversations", {
    method: "POST",
    body: JSON.stringify({ goal }),
  });
}

export function getConversation(id: string): Promise<Conversation> {
  return request(`/conversations/${id}`);
}
