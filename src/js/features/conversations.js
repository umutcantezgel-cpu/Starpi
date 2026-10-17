// @ts-check
// Conversations: the conversation list in the sidebar (#chat-sidebar, chat/sidebar.js). Mounting it
// also opens the conversation store, which runs the one-time start-up migrations (the 2.x chats in
// localStorage, the plaintext provider keys; each runs once per browser profile). The list and the
// store load as their own chunks; the chat modules they work with are part of the app already.
import { registerFeature } from './registry.js';

/** @type {import('./registry.js').Feature} */
const feature = {
  id: 'conversations',
  async mount(el, ctx) {
    const facade = await import('../chat-store.js');
    // Started first: the store and the migrations load while the list does.
    const ready = facade.chatData();
    ready.catch(() => {});
    const [{ mountConversationList }, chat, { APP_VERSION }] = await Promise.all([import('../chat/sidebar.js'), import('../chat.js'), import('../config.js')]);
    mountConversationList(el, ctx, {
      store: facade.chatData,
      currentId: facade.currentSessionId,
      onSessionChange: facade.onSessionChange,
      open: (id) => chat.openConversation(id),
      remove: (id) => facade.deleteSession(id),
      isBusy: chat.isChatBusy,
      afterRemoveCurrent: () => chat.resetConversation(),
      settle: facade.waitForWrites,
      version: APP_VERSION,
    });
  },
};

registerFeature('chat-sidebar', feature);
