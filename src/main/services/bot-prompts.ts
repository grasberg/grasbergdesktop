/**
 * Bot Mode — pure text/protocol helpers (no Electron, no DB): the teammate
 * roster + messaging protocol injected into canonical bot chats, the group
 * room turn prompt, @mention parsing and the reply-or-pass round rules.
 * Mirrors Hermes Desktop Bot Mode semantics: fire-and-forget bot-to-bot
 * messages, up to three serial reply-or-pass rounds per user message in a
 * room, @user escalation.
 */

export interface BotIdentity {
  name: string
  title: string
  description: string
}

/** Hermes caps: a room settles after at most 3 serial rounds per user send. */
export const GROUP_MAX_ROUNDS = 3
/** ... and never produces more than 10 bot messages per user send. */
export const GROUP_MAX_MESSAGES = 10
/** Rooms hold 2–6 bots (Hermes limits). */
export const GROUP_MIN_MEMBERS = 2
export const GROUP_MAX_MEMBERS = 6
/** Bot-to-bot delivery chains stop after this many hops (ping-pong guard). */
export const MAX_BOT_HOPS = 6

const GROUP_TRANSCRIPT_MAX_CHARS = 12_000

/** "Research Buddy" → "research-buddy" (the @taggable handle). */
export function botSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Case/punctuation-insensitive key: "@research-buddy" ≡ "Research Buddy". */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Resolves a message_agent target or @mention against the roster: matches the
 * exact name, the slug, or the squashed alias (Hermes: "@research-buddy or
 * @researchbuddy"). Returns the matched name or null.
 */
export function matchBotName(names: readonly string[], target: string): string | null {
  const key = nameKey(target.replace(/^@/, ''))
  if (!key) return null
  return names.find((name) => nameKey(name) === key) ?? null
}

/**
 * Bot names @mentioned in `text`, in order of first appearance, deduplicated.
 * Longer names win overlaps ("@research-buddy" never half-matches "@research").
 */
export function parseBotMentions(text: string, names: readonly string[]): string[] {
  const found: Array<{ index: number; name: string }> = []
  for (const name of names) {
    const slug = botSlug(name)
    const squashed = nameKey(name)
    for (const alias of new Set([slug, squashed])) {
      if (!alias) continue
      // Word-boundary-ish: the alias must not continue with a word character.
      const re = new RegExp(`@${escapeRegExp(alias)}(?![\\p{L}\\p{N}-])`, 'iu')
      const match = re.exec(text)
      if (match) {
        found.push({ index: match.index, name })
        break
      }
    }
  }
  found.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  return found.filter(({ name }) => (seen.has(name) ? false : (seen.add(name), true))).map((f) => f.name)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when a group-turn reply escalates to the user (Hermes @user mention). */
export function mentionsUser(text: string): boolean {
  return /@user(?![\p{L}\p{N}-])/iu.test(text)
}

/**
 * A group-turn reply that declines to speak. The instruction asks for the
 * exact token PASS; be lenient about whitespace/punctuation but nothing else —
 * a reply that merely STARTS with "PASS" and continues is a real reply.
 */
export function isPassReply(text: string): boolean {
  return /^\s*pass[.!]?\s*$/i.test(text)
}

/**
 * Who speaks in a round (Hermes: "@-mentioned bots respond; everyone responds
 * when nobody is mentioned"). Mention scoping applies to the FIRST round —
 * follow-up rounds are open to every member reacting to what was said.
 */
export function planRoundParticipants(
  members: readonly string[],
  mentioned: readonly string[],
  round: number
): string[] {
  if (round === 1 && mentioned.length > 0) {
    return members.filter((name) => mentioned.includes(name))
  }
  return [...members]
}

function rosterLines(teammates: readonly BotIdentity[]): string {
  return teammates
    .map((mate) => {
      const title = mate.title.trim()
      const description = mate.description.trim()
      const detail = [title, description].filter((part) => part.length > 0).join(' — ')
      return `- ${mate.name} (@${botSlug(mate.name)})${detail ? `: ${detail}` : ''}`
    })
    .join('\n')
}

/**
 * The Bot Mode protocol section appended to a canonical bot chat's system
 * prompt: identity, teammate roster, and the message_agent contract.
 */
export function buildBotChatSection(self: BotIdentity, teammates: readonly BotIdentity[]): string {
  const lines = [
    '## Bot Mode',
    `You are the bot "${self.name}"${self.title.trim() ? ` — ${self.title.trim()}` : ''}. ` +
      'This is your own persistent chat: the user talks to you here, other bots message you here, ' +
      'and your routines report here. Stay in character for your role.',
  ]
  if (teammates.length > 0) {
    lines.push(
      'Your teammates (other bots on this desktop):\n' + rosterLines(teammates),
      'To hand work to a teammate or ask them something, call the message_agent tool with their ' +
        'name. Delivery is fire-and-forget: you get an acknowledgement now, finish your turn, and ' +
        'their reply arrives in this chat later as an incoming message. Compose your own message — ' +
        'never forward the user’s text verbatim. When the user @mentions a teammate, they want ' +
        'you to bring that bot in via message_agent. Incoming lines prefixed "Message from 🤖" or ' +
        '"Reply from 🤖" come from teammates, not the user; answer a message when a reply is ' +
        'useful, and let a chain end rather than acknowledging back and forth.'
    )
  } else {
    lines.push('No other bots exist yet, so the message_agent tool has no valid targets.')
  }
  return lines.join('\n\n')
}

/**
 * The one-shot prompt for a member's turn in a group room. Rides
 * generateForWorkflow (persona + the bot's own memories become the system
 * prompt); this is the user-message side: room framing, transcript, and the
 * reply-briefly-or-PASS contract.
 */
export function buildGroupTurnPrompt(input: {
  self: BotIdentity
  roomName: string
  members: readonly BotIdentity[]
  /** Room transcript, oldest first. `speaker` is 'User' or a bot name. */
  transcript: ReadonlyArray<{ speaker: string; text: string }>
}): string {
  const others = input.members.filter((member) => member.name !== input.self.name)
  const transcriptText = capTranscript(
    input.transcript.map((entry) => `${entry.speaker}: ${entry.text}`).join('\n\n')
  )
  return [
    `You are "${input.self.name}"${input.self.title.trim() ? ` (${input.self.title.trim()})` : ''}, ` +
      `one member of the group chat "${input.roomName}". Members:\n` +
      rosterLines(input.members),
    `Transcript so far:\n---\n${transcriptText}\n---`,
    'It is your turn. Reply ONLY if you have something new and useful to add that no one has ' +
      'said yet — otherwise answer with exactly PASS and nothing else. Keep a reply brief (a few ' +
      'sentences), speak in your own voice for your role, and address teammates by @name when ' +
      `relevant${others.length > 0 ? ` (e.g. @${botSlug(others[0].name)})` : ''}. ` +
      'If a real judgment call needs the human, include @user in your reply.',
  ].join('\n\n')
}

function capTranscript(text: string): string {
  if (text.length <= GROUP_TRANSCRIPT_MAX_CHARS) return text
  return `[earlier discussion truncated]\n\n…${text.slice(-GROUP_TRANSCRIPT_MAX_CHARS)}`
}

// -- heartbeat (v47, OpenClaw contract) ---------------------------------------

/** The quiet answer: a heartbeat turn that surfaces nothing is deleted. */
export const HEARTBEAT_NO_REPLY = 'NO_REPLY'

/**
 * Lenient NO_REPLY detection (OpenClaw accepts the token at the start or end
 * with up to ~300 chars of trailing filler around it): exact token, or a reply
 * that STARTS with the token and stays short.
 */
export function isHeartbeatQuiet(reply: string): boolean {
  const trimmed = reply.trim()
  if (trimmed === HEARTBEAT_NO_REPLY) return true
  return trimmed.startsWith(HEARTBEAT_NO_REPLY) && trimmed.length <= HEARTBEAT_NO_REPLY.length + 300
}

/**
 * The user-message side of a heartbeat turn in the bot's canonical chat. The
 * persona/system prompt rides along as in any turn; this carries the contract.
 */
export function buildHeartbeatPrompt(extra?: string | null): string {
  const custom = (extra ?? '').trim()
  return (
    '[Heartbeat] Periodic check-in — no one asked a question. Review this chat, your role and ' +
    'your memory: is there anything that genuinely needs the user’s attention or a next step ' +
    `you should surface right now? If not — and usually there is not — reply with exactly ` +
    `${HEARTBEAT_NO_REPLY} and nothing else. Recurring work belongs in scheduled routines, not ` +
    'here; do not invent tasks to look busy.' +
    (custom ? `\n\nStanding heartbeat instructions from the user:\n${custom}` : '')
  )
}

/** Incoming bot-to-bot message as persisted into the target's canonical chat. */
export function formatIncomingBotMessage(senderName: string, message: string): string {
  return `Message from 🤖 ${senderName} (@${botSlug(senderName)}): ${message}`
}

/**
 * An app-originated wake (from_agent_id NULL in a2a_outbox: an event or a
 * routine trigger) as persisted into the bot's canonical chat.
 */
export function formatIncomingEvent(body: string): string {
  return `Event: ${body}`
}

/** A teammate's reply as persisted back into the sender's canonical chat. */
export function formatBotReply(targetName: string, reply: string): string {
  return `Reply from 🤖 ${targetName} (@${botSlug(targetName)}): ${reply}`
}

/** A failed delivery, as persisted into the sender's canonical chat. */
export function formatDeliveryFailure(targetName: string, reason: string, detail: string): string {
  return (
    `Message to 🤖 ${targetName} failed (${reason}): ${detail} ` +
    `(reason codes mirror provider errors; auth/config failures need the user, transient ones were retried once)`
  )
}
