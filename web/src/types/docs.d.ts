export interface IDocTreeNode {
  slug: string
  title: string
  /** Only its owner can see it, so only they see it here, marked. */
  private?: boolean
  children: IDocTreeNode[]
}
