import { View } from "react-native";
import { useRouter } from "expo-router";
import { Screen } from "@/src/components/Screen";
import { NotificationList } from "@/src/components/notifications/NotificationList";
import { Button } from "@/src/components/ui";
import { useNotifications } from "@/src/hooks/use-notifications";

// Mobile/narrow-width inbox. On wide layouts the same data lives in the top-bar Mentions dropdown.
export default function NotificationsScreen() {
  const router = useRouter();
  const inbox = useNotifications(60);
  return (
    <Screen title="Mentions" subtitle={inbox.unread ? `${inbox.unread} unread` : "You're all caught up"} testID="notifications-screen">
      {inbox.unread > 0 ? <View style={{ marginBottom: 12 }}><Button title="Mark all read" variant="secondary" onPress={inbox.markAllRead} testID="mentions-mark-all" /></View> : null}
      <NotificationList
        items={inbox.items}
        loading={inbox.loading}
        error={inbox.error}
        onRetry={inbox.reload}
        onOpen={(item) => {
          if (!item.read) inbox.markRead(item.id);
          router.push(item.link as any);
        }}
      />
    </Screen>
  );
}
