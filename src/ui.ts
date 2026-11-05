/**
 * `@aurologic/mist-api/ui`: a plugin's UI inside Discord's. An error boundary, observable state, a
 * mount point that survives hot reloads, and shared registries for chat bar buttons, message hover
 * bar buttons, UI under messages, and hooks before a message is sent or edited.
 */
export { Boundary, boundary } from "./ui/boundary.ts";
export type { BoundaryOptions, BoundaryProps, Fallback } from "./ui/boundary.ts";
export { host } from "./ui/host.ts";
export type { Host, HostOptions } from "./ui/host.ts";
export { messages } from "./ui/messages.ts";
export type { EditDraft, Listener, SendDraft, Verdict } from "./ui/messages.ts";
export { accessories, ChatBarButton, chatBar, popover } from "./ui/registries.ts";
export type { AccessoryProps, ChatBarButtonProps, ChatBarProps, EntryOptions, Message, PopoverButtonProps, PopoverProps } from "./ui/registries.ts";
export type { ContextOwner, ErrorLog, MistOwner, Owner } from "./ui/shared.ts";
export { state, useValue } from "./ui/state.ts";
export type { Readable, State } from "./ui/state.ts";
export { PluginPermissionError, UnknownPluginError } from "./permissions.ts";
