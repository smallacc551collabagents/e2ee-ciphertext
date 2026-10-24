import type { ChatAdapter, ConversationView, MessageView } from "./types";

// DEV/TEST ONLY. Selected only when NEXT_PUBLIC_CHAT_FIXTURES=1 AND NODE_ENV !== "production"
// (see ./index.ts). Never used on the deployed app.
const t = (h: number, m: number, daysAgo = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const convos: ConversationView[] = [
  { id: "c1", name: "Ava Testwell", preview: "Sounds good, see you then!", lastActivityAt: t(10, 42), unread: 2 },
  { id: "c2", name: "Project Falcon", preview: "Liam: pushed the new build", lastActivityAt: t(10, 15), unread: 5 },
  { id: "c3", name: "Mia Sample", preview: "Thanks for the safety number", lastActivityAt: t(18, 0, 1), unread: 0 },
  { id: "c4", name: "Zoe Example", preview: "", lastActivityAt: t(9, 0, 4), unread: 0 },
];
const messages: Record<string, MessageView[]> = {
  c1: [
    { id: "m1", fromMe: false, text: "Hey! Did you verify my safety number?", sentAt: t(10, 30), status: "read" },
    { id: "m2", fromMe: true, text: "Yes, just compared it in person. All good.", sentAt: t(10, 32), status: "read" },
    { id: "m3", fromMe: false, text: "Great. Lunch on Friday at noon?", sentAt: t(10, 38), status: "read" },
    { id: "m4", fromMe: true, text: "<b>plain text only</b>", sentAt: t(10, 40), status: "delivered" },
    { id: "m5", fromMe: true, text: "Sounds good, see you then!", sentAt: t(10, 42), status: "delivered" },
  ],
  c2: [{ id: "m6", fromMe: false, text: "Liam: pushed the new build", sentAt: t(10, 15), status: "read" }],
  c3: [{ id: "m7", fromMe: false, text: "Thanks for the safety number", sentAt: t(18, 0, 1), status: "read" }],
  c4: [],
};
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150));

export const fixturesAdapter: ChatAdapter = {
  id: "fixtures",
  listConversations: () => delay(convos.map((c) => ({ ...c }))),
  listMessages: (id) => delay([...(messages[id] ?? [])]),
  async sendMessage(id, text, clientId) {
    await delay(null);
    if (text.toLowerCase().includes("fail")) throw new Error("send failed");
    const m: MessageView = { id: `s-${clientId}`, clientId, fromMe: true, text, sentAt: new Date().toISOString(), status: "sent" };
    (messages[id] ??= []).push(m);
    return m;
  },
};
