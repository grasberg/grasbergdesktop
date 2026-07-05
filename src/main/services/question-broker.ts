/**
 * QuestionBroker — pending ask_user_question dialogs, bridging the chat tool
 * loop (main) and the user's answer click (renderer). Mirrors ApprovalBroker
 * but resolves to the chosen answer string, or null when the user dismissed
 * the dialog, it timed out, the stream was stopped, or the app quit.
 */

import type { UserQuestionRequest } from '@shared/types'
import { CHANNELS } from '@shared/ipc'
import { PendingBroker } from './pending-broker'

/** Unanswered questions resolve to null after this long. */
export const QUESTION_TIMEOUT_MS = 5 * 60_000

export class QuestionBroker extends PendingBroker<UserQuestionRequest, string | null> {
  constructor(timeoutMs: number = QUESTION_TIMEOUT_MS) {
    super(CHANNELS.userQuestionRequest, CHANNELS.userQuestionSettled, null, timeoutMs)
  }
}
