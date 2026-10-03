export type AppNotification = {
  id: string;
  type: "feed_mention" | string;
  actor_id: string;
  actor_name: string;
  message_id: string;
  thread_id: string;
  parent_id?: string | null;
  title: string;
  preview: string;
  /** In-app route, e.g. `/whiteboard?message=<id>&thread=<id>`. */
  link: string;
  read: boolean;
  created_at: string;
};
