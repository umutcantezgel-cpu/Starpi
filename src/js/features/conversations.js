// @ts-check
// Conversations: the conversation list in the sidebar (#chat-sidebar, chat/sidebar.js). Mounting it
// also opens the conversation store, which runs the one-time start-up migrations (the 2.x chats in
// localStorage, the plaintext provider keys; each runs once per browser profile). The list and the
// store load as their own chunks; the chat view is reached through the facade it binds itself to.
import { chatData, currentSessionId, deleteSession, getChatView, onSessionChange, waitForWrites } from '../chat-store.js';
import { APP_VERSION } from '../config.js';
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'conversations',
  async mount(el, ctx) {
    // Started first: the store and the migrations load while the list does.
    chatData().catch(() => {});
    const { mountConversationList } = await import('../chat/sidebar.js');
    mountConversationList(el, ctx, {
      store: chatData,
      currentId: currentSessionId,
      onSessionChange,
      open: async (id) => {
        await getChatView()?.open(id);
      },
      remove: deleteSession,
      isBusy: () => getChatView()?.isBusy() ?? false,
      answering: () => getChatView()?.answering?.() ?? null,
      afterRemoveCurrent: () => getChatView()?.reset(),
      settle: waitForWrites,
      version: APP_VERSION,
    });
  },
};

registerFeature('chat-sidebar', feature);
