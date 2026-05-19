import { CortexChatView } from '../components/CortexChatView';

export default async function CortexChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
  return <CortexChatView initialChatId={chatId} />;
}
