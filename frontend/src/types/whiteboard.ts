export type WhiteboardMention = {
  id: string;
  entity_type: "user" | "agent" | "group" | string;
  entity_id: string;
  handle: string;
  display_name: string;
};

export type WhiteboardAttachment = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
};

export type WhiteboardMessage = {
  id: string;
  thread_id: string;
  parent_id?: string | null;
  body: string;
  author_type: "user" | "agent" | "system";
  author_id: string;
  author_name: string;
  author_avatar: string;
  agent_label?: string | null;
  created_at: string;
  edited_at?: string | null;
  is_deleted: boolean;
  pinned: boolean;
  invocation_status?: "pending" | "responding" | "complete" | "failed" | null;
  invocation_error?: string | null;
  mentions: WhiteboardMention[];
  attachments: WhiteboardAttachment[];
  reply_count: number;
};

export type Mentionable = {
  id: string;
  handle: string;
  display_name: string;
  entity_type: "user" | "agent" | "group";
  label: string;
};
