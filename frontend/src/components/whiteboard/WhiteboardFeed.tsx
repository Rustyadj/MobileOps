import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { apiUpload } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useWhiteboard } from "@/src/hooks/use-whiteboard";
import type { Mentionable, WhiteboardMessage } from "@/src/types/whiteboard";
import { colors, radii, spacing } from "@/src/theme";

type PickedAsset = DocumentPicker.DocumentPickerAsset;

const timeLabel = (value: string) => new Date(value).toLocaleTimeString(undefined, {
  hour: "numeric", minute: "2-digit",
});

const dayLabel = (value: string) => {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
};

function MentionText({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9._-]+)/g);
  return <Text style={styles.body}>{parts.map((part, index) => part.startsWith("@")
    ? <Text key={`${part}-${index}`} style={styles.mention}>{part}</Text>
    : part)}</Text>;
}

function avatarColor(message: WhiteboardMessage) {
  return message.author_type === "agent" ? colors.accent : colors.primary;
}

// User-facing name is "Live Feed" (MobileOps' internal comms tool). Internal
// identifiers (component/hook/route/collection names, "whiteboard_*" on the
// backend) stay as-is — only the on-screen label changed.
export function WhiteboardFeed({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { user } = useAuth();
  const board = useWhiteboard(compact ? 12 : 100, !compact);
  const [draft, setDraft] = useState("");
  const [assets, setAssets] = useState<PickedAsset[]>([]);
  const [replyTo, setReplyTo] = useState<WhiteboardMessage | null>(null);
  const [editing, setEditing] = useState<WhiteboardMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const nearBottomRef = useRef(true);
  const lastCountRef = useRef(0);

  const visible = compact ? board.messages.slice(-4) : board.messages;
  const messageById = useMemo(() => new Map(board.messages.map((message) => [message.id, message])), [board.messages]);
  const grouped = useMemo(() => {
    let lastDay = "";
    return visible.map((message) => {
      const day = new Date(message.created_at).toDateString();
      const showDivider = day !== lastDay;
      lastDay = day;
      return { message, showDivider };
    });
  }, [visible]);

  const mentionQuery = useMemo(() => draft.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/)?.[1]?.toLowerCase(), [draft]);
  const suggestions = mentionQuery === undefined ? [] : board.mentionables
    .filter((entry) => entry.handle.toLowerCase().includes(mentionQuery) || entry.display_name.toLowerCase().includes(mentionQuery))
    .slice(0, compact ? 3 : 6);

  const scrollToEnd = (animated = true) => scrollRef.current?.scrollToEnd({ animated });

  useEffect(() => {
    if (visible.length > lastCountRef.current) {
      if (nearBottomRef.current) {
        requestAnimationFrame(() => scrollToEnd(lastCountRef.current > 0));
      } else {
        setNewBelow(true);
      }
    }
    lastCountRef.current = visible.length;
  }, [visible.length]);

  const handleScroll = (event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const atBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 64;
    nearBottomRef.current = atBottom;
    setNearBottom(atBottom);
    if (atBottom) setNewBelow(false);
  };

  const jumpToLatest = () => {
    scrollToEnd();
    setNewBelow(false);
  };

  const chooseMention = (entry: Mentionable) => {
    setDraft((current) => current.replace(/@([A-Za-z0-9._-]*)$/, `@${entry.handle} `));
  };

  const chooseAttachments = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled) setAssets((current) => [...current, ...result.assets].slice(0, 5));
  };

  const removeAsset = (index: number) => setAssets((current) => current.filter((_, i) => i !== index));

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await board.edit(editing.id, body);
      } else {
        const created = await board.send(body, replyTo?.id);
        if (assets.length) {
          const form = new FormData();
          assets.forEach((asset) => form.append("files", Platform.OS === "web" && asset.file
            ? asset.file
            : ({ uri: asset.uri, name: asset.name, type: asset.mimeType || "application/octet-stream" } as any)));
          await apiUpload(`/whiteboard/messages/${created.id}/attachments`, form);
        }
      }
      setDraft("");
      setAssets([]);
      setReplyTo(null);
      setEditing(null);
    } catch (cause: any) {
      Alert.alert("Live Feed", cause?.message || "Message could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (message: WhiteboardMessage) => {
    setEditing(message);
    setReplyTo(null);
    setDraft(message.body);
  };

  const cancelComposerMode = () => {
    setEditing(null);
    setReplyTo(null);
    setDraft("");
  };

  const liveState = board.error ? "error" : board.loading ? "connecting" : "live";

  return (
    <View style={[styles.panel, compact && styles.compactPanel]} testID={compact ? "dashboard-whiteboard" : "whiteboard-feed"}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Ionicons name="chatbubbles-outline" size={16} color={colors.primary} />
          <Text style={styles.title}>LIVE FEED</Text>
          <View style={[styles.liveDot, liveState === "live" && styles.liveDotOn, liveState === "error" && styles.liveDotError]} />
          {!compact ? <Text style={styles.liveLabel}>{liveState === "live" ? "Live" : liveState === "error" ? "Offline" : "Connecting…"}</Text> : null}
          {board.unread > 0 ? <View style={styles.unread}><Text style={styles.unreadText}>{board.unread}</Text></View> : null}
        </View>
        {compact ? (
          <TouchableOpacity onPress={() => router.push("/(app)/whiteboard" as any)} testID="whiteboard-open-full">
            <Text style={styles.viewAll}>Open Live Feed →</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={board.reload} accessibilityLabel="Refresh feed" hitSlop={8}>
            <Ionicons name="refresh" size={17} color={colors.inkSecondary} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.feedWrap}>
        <ScrollView
          ref={scrollRef}
          style={[styles.feed, compact && styles.compactFeed]}
          contentContainerStyle={styles.feedContent}
          onScroll={handleScroll}
          scrollEventThrottle={32}
          nestedScrollEnabled
        >
          {board.loading ? (
            <View>
              {[0, 1, 2].map((row) => (
                <View key={row} style={styles.skeletonRow}>
                  <View style={styles.skeletonAvatar} />
                  <View style={styles.skeletonLines}>
                    <View style={[styles.skeletonLine, { width: "35%" }]} />
                    <View style={[styles.skeletonLine, { width: "80%" }]} />
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {board.error ? (
            <View style={styles.errorBox}>
              <Ionicons name="cloud-offline-outline" size={16} color={colors.error} />
              <Text style={styles.error}>{board.error}</Text>
              <TouchableOpacity onPress={board.reload}><Text style={styles.errorRetry}>Retry</Text></TouchableOpacity>
            </View>
          ) : null}
          {!board.loading && !board.error && !visible.length ? (
            <View style={styles.emptyState}>
              <Ionicons name="chatbubbles-outline" size={26} color={colors.inkMuted} />
              <Text style={styles.emptyTitle}>No updates yet</Text>
              <Text style={styles.empty}>Start the team feed with an update, a question, or mention @Nathan.</Text>
            </View>
          ) : null}
          {grouped.map(({ message, showDivider }) => {
            const own = message.author_id === user?.id;
            const parent = message.parent_id ? messageById.get(message.parent_id) : null;
            const failed = message.invocation_status === "failed";
            return (
              <View key={message.id}>
                {showDivider ? <View style={styles.dayDivider}><View style={styles.dayLine} /><Text style={styles.dayLabel}>{dayLabel(message.created_at)}</Text><View style={styles.dayLine} /></View> : null}
                <View
                  style={[styles.message, message.parent_id && styles.reply, message.pinned && styles.pinned, failed && styles.failed]}
                  testID={`whiteboard-message-${message.id}`}
                >
                  <View style={[styles.avatar, { backgroundColor: avatarColor(message) }]}><Text style={styles.avatarText}>{message.author_avatar || message.author_name.slice(0, 2).toUpperCase()}</Text></View>
                  <View style={styles.messageContent}>
                    <View style={styles.metaRow}>
                      <Text style={styles.author}>{message.author_name}</Text>
                      {message.agent_label ? <Text style={styles.aiBadge}>{message.agent_label}</Text> : null}
                      {message.pinned ? <Ionicons name="pin" size={12} color={colors.warning} /> : null}
                      <Text style={styles.time}>{timeLabel(message.created_at)}{message.edited_at ? " · edited" : ""}</Text>
                    </View>
                    {parent ? (
                      <View style={styles.replyQuote}>
                        <Ionicons name="arrow-undo-outline" size={11} color={colors.inkMuted} />
                        <Text style={styles.replyQuoteText} numberOfLines={1}><Text style={styles.replyQuoteAuthor}>{parent.author_name}</Text> · {parent.body}</Text>
                      </View>
                    ) : null}
                    <MentionText body={message.body} />
                    {message.attachments?.length ? <View style={styles.attachmentRow}>{message.attachments.map((attachment) => (
                      <View key={attachment.id} style={styles.attachment}><Ionicons name="attach" size={13} color={colors.primary} /><Text style={styles.attachmentText} numberOfLines={1}>{attachment.filename}</Text></View>
                    ))}</View> : null}
                    {message.invocation_status === "responding" || message.invocation_status === "pending" ? (
                      <View style={styles.respondingRow}><View style={styles.respondingDot} /><Text style={styles.responding}>Nathan is responding…</Text></View>
                    ) : null}
                    {failed ? (
                      <View style={styles.failureRow}><Ionicons name="alert-circle" size={13} color={colors.error} /><Text style={styles.failureText}>Nathan could not respond. Your message is still here.</Text></View>
                    ) : null}
                    {!compact && !message.is_deleted ? (
                      <View style={styles.actions}>
                        <TouchableOpacity onPress={() => { setReplyTo(message); setEditing(null); setDraft(""); }}><Text style={styles.action}>Reply{message.reply_count ? ` (${message.reply_count})` : ""}</Text></TouchableOpacity>
                        {own ? <TouchableOpacity onPress={() => beginEdit(message)}><Text style={styles.action}>Edit</Text></TouchableOpacity> : null}
                        {own || user?.role === "admin" ? <TouchableOpacity onPress={() => Alert.alert("Delete message?", "The audit record will be retained.", [{ text: "Cancel" }, { text: "Delete", style: "destructive", onPress: () => board.remove(message.id).catch((error) => Alert.alert("Live Feed", error.message)) }])}><Text style={[styles.action, styles.deleteAction]}>Delete</Text></TouchableOpacity> : null}
                        {user?.role === "admin" ? <TouchableOpacity onPress={() => board.pin(message.id, !message.pinned).catch((error) => Alert.alert("Live Feed", error.message))}><Text style={styles.action}>{message.pinned ? "Unpin" : "Pin"}</Text></TouchableOpacity> : null}
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
        {newBelow ? (
          <TouchableOpacity style={styles.jumpPill} onPress={jumpToLatest}>
            <Ionicons name="arrow-down" size={13} color={colors.bg} />
            <Text style={styles.jumpPillText}>New messages</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {suggestions.length ? <View style={styles.suggestions}>{suggestions.map((entry) => (
        <TouchableOpacity key={`${entry.entity_type}-${entry.id}`} style={styles.suggestion} onPress={() => chooseMention(entry)}>
          <Text style={styles.suggestionHandle}>@{entry.handle}</Text><Text style={styles.suggestionName}>{entry.display_name} · {entry.label}</Text>
        </TouchableOpacity>
      ))}</View> : null}

      {(replyTo || editing) ? <View style={styles.composerMode}><Text style={styles.composerModeText}>{editing ? `Editing your message` : `Replying to ${replyTo?.author_name}`}</Text><TouchableOpacity onPress={cancelComposerMode} hitSlop={8}><Ionicons name="close" size={16} color={colors.inkSecondary} /></TouchableOpacity></View> : null}
      {assets.length ? <View style={styles.attachmentRow}>{assets.map((asset, index) => (
        <View key={`${asset.name}-${index}`} style={styles.attachment}>
          <Text style={styles.attachmentText} numberOfLines={1}>{asset.name}</Text>
          <TouchableOpacity onPress={() => removeAsset(index)} hitSlop={6}><Ionicons name="close-circle" size={14} color={colors.inkMuted} /></TouchableOpacity>
        </View>
      ))}</View> : null}
      <View style={styles.composer}>
        <TouchableOpacity onPress={chooseAttachments} style={styles.attachButton} accessibilityLabel="Attach file" testID="whiteboard-attach"><Ionicons name="attach" size={19} color={colors.inkSecondary} /></TouchableOpacity>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="Share an update, or mention @Nathan…"
          placeholderTextColor={colors.inkMuted}
          style={[styles.input, compact && styles.compactInput]}
          onKeyPress={(event: any) => {
            if (event.nativeEvent.key === "Enter" && !event.nativeEvent.shiftKey) {
              event.preventDefault?.();
              submit();
            }
          }}
          testID="whiteboard-input"
        />
        <TouchableOpacity disabled={!draft.trim() || busy} onPress={submit} style={[styles.send, (!draft.trim() || busy) && styles.sendDisabled]} testID="whiteboard-send">
          <Ionicons name={busy ? "hourglass-outline" : "send"} size={16} color={colors.bg} />
        </TouchableOpacity>
      </View>
      {!compact ? <Text style={styles.hint}>Enter to send · Shift+Enter for a new line · Mention @Nathan for the AI operations agent</Text> : null}
    </View>
  );
}

const shadowPill = Platform.select({
  ios: { shadowColor: "#0F172A", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.18, shadowRadius: 6 },
  android: { elevation: 3 },
  default: { boxShadow: "0 2px 6px rgba(15, 23, 42, 0.18)" },
}) as object;

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  compactPanel: { maxHeight: 380 },
  header: { minHeight: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkMuted },
  liveDotOn: { backgroundColor: colors.success },
  liveDotError: { backgroundColor: colors.error },
  liveLabel: { fontSize: 10.5, color: colors.inkMuted, fontWeight: "600" },
  viewAll: { fontSize: 11.5, color: colors.primary, fontWeight: "700" },
  unread: { minWidth: 19, height: 19, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.error },
  unreadText: { color: colors.bg, fontSize: 10, fontWeight: "800" },
  feedWrap: { flex: 1, position: "relative" },
  feed: { flex: 1 },
  feedContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  compactFeed: { maxHeight: 270 },
  dayDivider: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 },
  dayLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dayLabel: { fontSize: 10.5, fontWeight: "700", color: colors.inkMuted, letterSpacing: 0.3 },
  skeletonRow: { flexDirection: "row", gap: 9, paddingVertical: 9 },
  skeletonAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bgTint },
  skeletonLines: { flex: 1, gap: 6, justifyContent: "center" },
  skeletonLine: { height: 9, borderRadius: 4, backgroundColor: colors.bgTint },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: spacing.md, backgroundColor: colors.errorSoft, borderRadius: radii.sm, marginBottom: spacing.sm },
  error: { flex: 1, color: colors.error, fontSize: 12 },
  errorRetry: { color: colors.error, fontSize: 12, fontWeight: "800" },
  emptyState: { alignItems: "center", gap: 6, paddingVertical: spacing.xl },
  emptyTitle: { fontSize: 13, fontWeight: "800", color: colors.inkSecondary },
  empty: { maxWidth: 260, textAlign: "center", color: colors.inkMuted, fontSize: 12, lineHeight: 17 },
  message: { flexDirection: "row", gap: 9, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  reply: { marginLeft: 24, paddingLeft: 8 },
  pinned: { backgroundColor: colors.warningSoft, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: radii.sm },
  failed: { backgroundColor: colors.errorSoft, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: radii.sm },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.bg, fontWeight: "800", fontSize: 10 },
  messageContent: { flex: 1, minWidth: 0 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  author: { fontSize: 12.5, fontWeight: "800", color: colors.ink },
  time: { fontSize: 10.5, color: colors.inkMuted },
  aiBadge: { fontSize: 9.5, fontWeight: "800", color: colors.accent, backgroundColor: colors.bgTint, paddingHorizontal: 5, paddingVertical: 2, borderRadius: radii.sm },
  replyQuote: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3, marginBottom: 1 },
  replyQuoteText: { flex: 1, fontSize: 11, color: colors.inkMuted },
  replyQuoteAuthor: { fontWeight: "700", color: colors.inkSecondary },
  body: { marginTop: 3, fontSize: 12.5, lineHeight: 18, color: colors.ink },
  mention: { color: colors.primary, fontWeight: "800", backgroundColor: colors.primarySoft },
  respondingRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  respondingDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.accent },
  responding: { color: colors.accent, fontSize: 11, fontStyle: "italic" },
  failureRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  failureText: { color: colors.error, fontSize: 11 },
  actions: { flexDirection: "row", gap: 14, marginTop: 6 },
  action: { color: colors.primary, fontSize: 10.5, fontWeight: "700" },
  deleteAction: { color: colors.error },
  attachmentRow: { flexDirection: "row", flexWrap: "wrap", gap: 5, paddingHorizontal: 10, paddingVertical: 4 },
  attachment: { maxWidth: 210, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7, paddingVertical: 4, backgroundColor: colors.bgMuted, borderRadius: radii.sm },
  attachmentText: { maxWidth: 160, color: colors.inkSecondary, fontSize: 10.5 },
  jumpPill: { position: "absolute", bottom: 10, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.primary, ...shadowPill },
  jumpPillText: { color: colors.bg, fontSize: 11, fontWeight: "700" },
  suggestions: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, paddingVertical: 4 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7 },
  suggestionHandle: { width: 90, fontSize: 11.5, fontWeight: "800", color: colors.primary },
  suggestionName: { flex: 1, fontSize: 11, color: colors.inkSecondary },
  composerMode: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.primarySoft },
  composerModeText: { color: colors.primary, fontWeight: "700", fontSize: 11 },
  composer: { minHeight: 52, flexDirection: "row", alignItems: "flex-end", gap: 7, padding: 8, borderTopWidth: 1, borderTopColor: colors.border },
  attachButton: { width: 32, height: 36, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, minHeight: 38, maxHeight: 110, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, color: colors.ink, fontSize: 12.5 },
  compactInput: { maxHeight: 72 },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.4 },
  hint: { paddingHorizontal: 12, paddingBottom: 8, color: colors.inkMuted, fontSize: 10 },
});
