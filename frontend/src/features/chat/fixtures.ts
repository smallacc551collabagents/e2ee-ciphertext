// MOCK FIXTURES ONLY — no sockets, no crypto. Replaced by real data in later phases.
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";
export interface Message { id: string; fromMe: boolean; text: string; at: string; status: MessageStatus }
export interface Conversation { id: string; peer: string; lastMessage: string; unread: number; messages: Message[] }

export const conversations: Conversation[] = [
  {
    id: "c1", peer: "alice", lastMessage: "See you tomorrow!", unread: 2,
    messages: [
      { id: "m1", fromMe: false, text: "Hey! Did the build pass?", at: "09:12", status: "read" },
      { id: "m2", fromMe: true, text: "Yes, all green.", at: "09:13", status: "read" },
      { id: "m3", fromMe: true, text: "Pushing the release notes now.", at: "09:14", status: "delivered" },
      { id: "m4", fromMe: true, text: "<b>plain text only</b> — markup is never rendered", at: "09:15", status: "sent" },
      { id: "m5", fromMe: true, text: "This one didn't go through.", at: "09:16", status: "failed" },
      { id: "m6", fromMe: false, text: "See you tomorrow!", at: "09:20", status: "read" },
    ],
  },
  { id: "c2", peer: "bob", lastMessage: "Thanks 👍", unread: 0, messages: [
    { id: "m7", fromMe: false, text: "Thanks 👍", at: "Yesterday", status: "read" },
  ] },
  { id: "c3", peer: "carol", lastMessage: "", unread: 0, messages: [] },
];
