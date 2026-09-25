/**
 * Who may change a comment after it is written.
 *
 * Two rules, in one place, because cards and documents keep their comments in
 * separate tables and everything else about them has already been written
 * twice.
 *
 * **Only the author may edit.** Not an admin, not anybody with write scope.
 * A comment is attributed to a person by name, so editing somebody else's and
 * leaving their face on it is putting words in their mouth. Before this,
 * `comment_update` checked nothing at all: anyone who could write could
 * rewrite anyone's comment.
 *
 * **Deleting is the workspace's call.** An author removing their own comment
 * is ordinary, and some workspaces would rather nothing disappeared from a
 * thread, so `workspace.comment_delete` chooses. An admin can always delete,
 * whatever the setting, because moderating is the reason the role exists.
 */
import { ApiError, type ICtx } from '../core/ctx'

export type TCommentDeletePolicy = 'author' | 'admin'

export async function commentDeletePolicy(
  ctx: ICtx,
): Promise<TCommentDeletePolicy> {
  const row = (
    await ctx.db.query<{ comment_delete: string | null }>(
      'SELECT comment_delete FROM workspace WHERE id = ?',
      [ctx.workspaceId],
    )
  )[0]
  return row?.comment_delete === 'admin' ? 'admin' : 'author'
}

export function canEditComment(ctx: ICtx, authorId: string): boolean {
  return authorId === ctx.actor.id
}

export function canDeleteComment(
  ctx: ICtx,
  authorId: string,
  policy: TCommentDeletePolicy,
): boolean {
  if (ctx.actor.role === 'admin') return true
  return policy === 'author' && authorId === ctx.actor.id
}

/** The same two rules, as the refusal a write path owes the caller. */
export function assertCanEditComment(ctx: ICtx, authorId: string): void {
  if (!canEditComment(ctx, authorId))
    throw new ApiError(403, 'only the author can edit a comment')
}

export function assertCanDeleteComment(
  ctx: ICtx,
  authorId: string,
  policy: TCommentDeletePolicy,
): void {
  if (canDeleteComment(ctx, authorId, policy)) return
  throw new ApiError(
    403,
    policy === 'admin'
      ? 'only an admin can delete a comment in this workspace'
      : 'only the author or an admin can delete a comment',
  )
}
