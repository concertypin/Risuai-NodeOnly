/**
 * @fileoverview Chat store — manages in-memory full chat cache.
 *
 * Ported from server.cjs:
 *   - chatToStub()        — compress chat to stub
 *   - initChatStore()     — initialize from DB object
 *   - stripChatsFromDb()  — remove full chats from DB object
 *   - reassembleFullDb()  — merge stubs with full chat store
 *   - mergeChatStubWithFullChat() — merge single stub with full chat
 *   - findStubFlagLossChats()     — detect hybrid corruption
 */

import { randomUUID } from 'node:crypto';

export interface Chat {
  id?: string;
  name?: string;
  _stub?: boolean;
  message?: unknown[];
  lastDate?: string | null;
  folderId?: string | null;
  modules?: unknown;
  [key: string]: unknown;
}

export interface Character {
  chaId?: string;
  chats?: Chat[];
  chatFolders?: { id?: string }[];
  [key: string]: unknown;
}

export interface DbObject {
  characters?: Character[];
  [key: string]: unknown;
}

// ─── In-memory store ────────────────────────────────────────────────────────

export type FullChatStore = Map<string, Map<string, Chat>>;
let fullChatStore: FullChatStore | null = null;

export function getFullChatStore(): FullChatStore | null {
  return fullChatStore;
}

export function setFullChatStore(store: FullChatStore | null): void {
  fullChatStore = store;
}

// ─── Chat to stub ────────────────────────────────────────────────────────────

export function chatToStub(chat: Chat): Chat {
  if (!chat) return chat;
  if (chat._stub && !Array.isArray(chat.message)) return chat;
  const stub: Chat = {
    id: chat.id || '',
    name: chat.name ?? '',
    _stub: true,
  };
  if ('lastDate' in chat) stub.lastDate = chat.lastDate;
  if ('folderId' in chat) stub.folderId = chat.folderId;
  if ('modules' in chat) stub.modules = chat.modules;
  return stub;
}

// ─── Init chat store ────────────────────────────────────────────────────────

export function initChatStore(dbObj: DbObject): FullChatStore {
  const store: FullChatStore = new Map();
  if (!dbObj?.characters) {
    fullChatStore = store;
    return store;
  }
  for (const char of dbObj.characters) {
    if (!char?.chaId || !char.chats) continue;
    const charChats = new Map<string, Chat>();
    for (const chat of char.chats) {
      if (!chat) continue;
      const isStub = chat._stub === true;
      const hasMessage = Array.isArray(chat.message);
      if (isStub && !hasMessage) continue;
      if (isStub && hasMessage) {
        delete chat._stub;
      }
      if (!chat.id) {
        chat.id = randomUUID();
      }
      charChats.set(chat.id, chat);
    }
    if (charChats.size > 0) {
      store.set(char.chaId, charChats);
    }
  }
  fullChatStore = store;
  return store;
}

// ─── Strip chats ────────────────────────────────────────────────────────────

export function stripChatsFromDb(dbObj: DbObject): DbObject {
  if (!dbObj?.characters) return dbObj;
  const stripped = { ...dbObj };
  stripped.characters = dbObj.characters.map((char) => {
    if (!char?.chats) return char;
    return { ...char, chats: char.chats.map(chatToStub) };
  });
  return stripped;
}

// ─── Merge stub with full chat ──────────────────────────────────────────────

export function mergeChatStubWithFullChat(stub: Chat, fullChat: Chat | undefined): Chat {
  if (!fullChat) {
    return stub;
  }
  if (!stub || !stub._stub) {
    return fullChat;
  }
  const merged: Chat = {
    ...fullChat,
    id: stub.id || fullChat.id || '',
    name: stub.name,
  };
  if (fullChat._stub) {
    delete merged._stub;
  }
  if (stub.name !== fullChat.name) {
    merged.name = stub.name;
  }
  if ('folderId' in stub) {
    merged.folderId = stub.folderId;
  }
  if ('lastDate' in stub) {
    merged.lastDate = stub.lastDate;
  }
  if ('modules' in stub) {
    merged.modules = stub.modules;
  }
  return merged;
}

// ─── Reassemble full DB ─────────────────────────────────────────────────────

export function reassembleFullDb(strippedDb: DbObject): DbObject {
  const store = fullChatStore;
  if (!store || store.size === 0) return strippedDb;
  if (!strippedDb?.characters) return strippedDb;

  const result: DbObject = { ...strippedDb };
  result.characters = strippedDb.characters.map((char) => {
    if (!char?.chaId || !char.chats) return char;
    const charFullChats = store.get(char.chaId);
    if (!charFullChats) return char;

    return {
      ...char,
      chats: char.chats.map((stub) => {
        if (!stub._stub) return stub;
        const stubId = stub.id || '';
        const fullChat = stubId ? charFullChats.get(stubId) : undefined;
        return mergeChatStubWithFullChat(stub, fullChat);
      }),
    };
  });
  return result;
}

// ─── Find stub flag loss chats ──────────────────────────────────────────────

export function findStubFlagLossChats(dbObj: DbObject): Array<{ chaId: string; chatId?: string; chatIndex?: number }> {
  const losses: Array<{ chaId: string; chatId?: string; chatIndex?: number }> = [];
  if (!dbObj?.characters) return losses;
  const store = fullChatStore!;
  if (!store) return losses;
  for (const char of dbObj.characters) {
    if (!char?.chats) continue;
    const charStore = store.get(char.chaId || '');
    if (!charStore) continue;
    for (let i = 0; i < char.chats.length; i++) {
      const chat = char.chats[i];
      if (!chat || !chat._stub) continue;
      const chatId = chat.id || '';
      if (!chatId) continue;
      const fullChat = charStore.get(chatId);
      if (!fullChat) continue;
      if (!Array.isArray(fullChat.message)) continue;
      if (Array.isArray(chat.message)) continue;
      losses.push({ chaId: char.chaId || '', chatId, chatIndex: i });
    }
  }
  return losses;
}

// ─── Assign missing chat IDs ────────────────────────────────────────────────

export function assignMissingChatIds(dbObj: DbObject): boolean {
  let changed = false;
  if (!dbObj?.characters) return changed;
  for (const char of dbObj.characters) {
    if (!char?.chats) continue;
    for (const chat of char.chats) {
      if (!chat || chat._stub || chat.id) continue;
      chat.id = randomUUID();
      changed = true;
    }
  }
  return changed;
}

// ─── Normalize orphan folder IDs ────────────────────────────────────────────

export function normalizeOrphanFolderIds(dbObj: DbObject): boolean {
  let changed = false;
  if (!dbObj?.characters) return changed;
  for (const char of dbObj.characters) {
    if (!char?.chats) continue;
    const validIds = new Set((char.chatFolders ?? []).map((f) => f?.id).filter(Boolean));
    for (const chat of char.chats) {
      if (!chat) continue;
      if (chat.folderId && !validIds.has(chat.folderId as string)) {
        chat.folderId = null;
        changed = true;
      }
    }
  }
  return changed;
}
