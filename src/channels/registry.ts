import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /**
   * Unified channel mirror: ask the orchestrator to deliver a copy of `text`
   * to `toJid` via whichever channel owns it. Used to fan-out inbound and
   * agent-reply messages across all JIDs subscribed to the same group.
   *
   * Implementation guarantees:
   *  - Bypasses the inbound `onMessage` pipeline (no re-entry, no agent run).
   *  - Does NOT call `storeMessage` (no double-counting in agent history).
   *  - Picks the channel via `findChannel(channels, toJid)`; logs and drops if
   *    no channel owns that JID.
   *
   * Optional so channels written against an older orchestrator still compile.
   */
  mirrorSend?: (toJid: string, text: string) => Promise<void>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
