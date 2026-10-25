/**
 * Pure aggregation used by the Telegram workflow tools.
 *
 * Keeping this file free of GramJS makes the interesting logic testable
 * offline: sorting, grouping, question candidates, media counts and link
 * extraction are all deterministic functions over already-shaped messages.
 */

export type WorkflowMessage = {
  id: number;
  date?: string | null;
  text?: string;
  senderId?: string | null;
  senderName?: string | null;
  outgoing?: boolean;
  media?: { type?: string } | null;
  replyTo?: number | null;
  entities?: Array<{ type?: string; url?: string }> | null;
  views?: number | null;
  forwards?: number | null;
  reactions?: { total?: number } | null;
  chat?: { id?: string | null; title?: string | null };
};

export type SenderSummary = {
  key: string;
  name: string | null;
  count: number;
  outgoing: number;
};

export type DaySummary = { day: string; count: number };

export type QuestionCandidate = {
  id: number;
  date: string | null;
  senderName: string | null;
  text: string;
  directReplies: number;
  noDirectReply: boolean;
  link: string | null;
};

export type BriefingHighlight = {
  id: number;
  date: string | null;
  senderName: string | null;
  text: string;
  media: string | null;
  link: string | null;
};

export type Briefing = {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  bySender: SenderSummary[];
  byDay: DaySummary[];
  media: Record<string, number>;
  questionCandidates: QuestionCandidate[];
  highlights: BriefingHighlight[];
  links: string[];
  topViewed: BriefingHighlight[];
};

function senderKey(message: WorkflowMessage): string {
  return message.senderId ?? message.senderName ?? "unknown";
}

function clip(text: string, max = 500): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function dateOf(message: WorkflowMessage): string | null {
  return typeof message.date === "string" && message.date ? message.date : null;
}

function ordered(messages: WorkflowMessage[]): WorkflowMessage[] {
  return [...messages].sort((a, b) => Number(a.id) - Number(b.id));
}

export type BriefingOptions = {
  /** Build a link to a message in this chat. */
  linkFor?: (messageId: number) => string | null;
  maxQuestions?: number;
  maxHighlights?: number;
};

export function buildBriefing(messages: WorkflowMessage[], options: BriefingOptions = {}): Briefing {
  const list = ordered(messages);
  const linkFor = options.linkFor ?? (() => null);
  const senderMap = new Map<string, SenderSummary>();
  const dayMap = new Map<string, number>();
  const media: Record<string, number> = {};
  const links = new Set<string>();
  const questionCandidates: QuestionCandidate[] = [];

  for (const message of list) {
    const key = senderKey(message);
    const current = senderMap.get(key) ?? {
      key,
      name: message.senderName ?? null,
      count: 0,
      outgoing: 0,
    };
    current.count += 1;
    if (message.outgoing) current.outgoing += 1;
    if (!current.name && message.senderName) current.name = message.senderName;
    senderMap.set(key, current);

    const day = dateOf(message)?.slice(0, 10);
    if (day) dayMap.set(day, (dayMap.get(day) ?? 0) + 1);

    const mediaType = message.media?.type;
    if (mediaType) media[mediaType] = (media[mediaType] ?? 0) + 1;

    for (const entity of message.entities ?? []) {
      if (entity?.type === "url" && typeof entity.url === "string" && entity.url) links.add(entity.url);
    }

    const text = String(message.text ?? "");
    if (/[?？]/.test(text)) {
      questionCandidates.push({
        id: message.id,
        date: dateOf(message),
        senderName: message.senderName ?? null,
        text: clip(text),
        directReplies: 0, // will be filled in below
        noDirectReply: true, // will be updated below
        link: linkFor(message.id),
      });
    }
  }

  // O(N) pass to count direct replies for question candidates.
  const replyCounts = new Map<number, number>();
  for (const m of list) {
    if (m.replyTo) replyCounts.set(m.replyTo, (replyCounts.get(m.replyTo) ?? 0) + 1);
  }
  for (const qc of questionCandidates) {
    const count = replyCounts.get(qc.id) ?? 0;
    qc.directReplies = count;
    qc.noDirectReply = count === 0;
  }

  const bySender = [...senderMap.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const byDay = [...dayMap.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const recent = [...list].reverse();
  const highlights = recent
    .filter((message) => String(message.text ?? "").trim() || message.media?.type)
    .slice(0, options.maxHighlights ?? 8)
    .map((message) => ({
      id: message.id,
      date: dateOf(message),
      senderName: message.senderName ?? null,
      text: clip(String(message.text ?? "")),
      media: message.media?.type ?? null,
      link: linkFor(message.id),
    }));

  const topViewed = [...list]
    .filter((message) => Number(message.views ?? 0) > 0)
    .sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0))
    .slice(0, 5)
    .map((message) => ({
      id: message.id,
      date: dateOf(message),
      senderName: message.senderName ?? null,
      text: clip(String(message.text ?? "")),
      media: message.media?.type ?? null,
      link: linkFor(message.id),
    }));

  const first = list[0];
  const last = list[list.length - 1];

  return {
    count: list.length,
    firstAt: first ? dateOf(first) : null,
    lastAt: last ? dateOf(last) : null,
    bySender,
    byDay,
    media,
    questionCandidates: questionCandidates.slice(0, options.maxQuestions ?? 20),
    highlights,
    links: [...links].slice(0, 20),
    topViewed,
  };
}

export type SearchReport = {
  query: string;
  count: number;
  dateRange: { from: string | null; to: string | null };
  bySender: SenderSummary[];
  byChat: Array<{ id: string | null; title: string | null; count: number }>;
  media: Record<string, number>;
  results: Array<WorkflowMessage & { chat: { id: string | null; title: string | null } | null }>;
};

/**
 * Group search hits by sender and by chat. The flat result list stays intact so
 * an agent can cite exact messages; the groups answer "who is talking about
 * this?" without a second search.
 */
export function buildSearchReport(query: string, hits: WorkflowMessage[]): SearchReport {
  const senderMap = new Map<string, SenderSummary>();
  const chatMap = new Map<string, { id: string | null; title: string | null; count: number }>();
  const media: Record<string, number> = {};
  let from: string | null = null;
  let to: string | null = null;

  for (const hit of hits) {
    const key = senderKey(hit);
    const sender = senderMap.get(key) ?? {
      key,
      name: hit.senderName ?? null,
      count: 0,
      outgoing: 0,
    };
    sender.count += 1;
    if (hit.outgoing) sender.outgoing += 1;
    if (!sender.name && hit.senderName) sender.name = hit.senderName;
    senderMap.set(key, sender);

    const chatKey = String(hit.chat?.id ?? hit.chat?.title ?? "unknown");
    const chat = chatMap.get(chatKey) ?? {
      id: hit.chat?.id ?? null,
      title: hit.chat?.title ?? null,
      count: 0,
    };
    chat.count += 1;
    if (!chat.title && hit.chat?.title) chat.title = hit.chat.title;
    chatMap.set(chatKey, chat);

    const mediaType = hit.media?.type;
    if (mediaType) media[mediaType] = (media[mediaType] ?? 0) + 1;

    const date = dateOf(hit);
    if (date) {
      if (!from || date < from) from = date;
      if (!to || date > to) to = date;
    }
  }

  return {
    query,
    count: hits.length,
    dateRange: { from, to },
    bySender: [...senderMap.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    byChat: [...chatMap.values()].sort((a, b) => b.count - a.count),
    media,
    results: hits.map((hit) => ({
      ...hit,
      chat: { id: hit.chat?.id ?? null, title: hit.chat?.title ?? null },
    })),
  };
}
