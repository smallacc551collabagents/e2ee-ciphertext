import { getSession } from "@/lib/api/server";
import { ChatView } from "@/features/chat/ChatView";

export default async function ChatPage() {
  const user = await getSession(); // layout already guarantees a session
  return <ChatView username={user?.username ?? ""} />;
}
