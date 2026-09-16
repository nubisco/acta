# Working in Acta

## Views

A space can be read five ways. They are the same cards, not five feature sets.

![The board view](/media/board.jpg)

**Board** is the default: lists as columns, cards in them, drag to move. Column
headers stay put as you scroll. **Swimlanes** split the board into horizontal
bands by assignee, label or status, which is how you see that one person holds
nine of the twelve in-progress cards.

**Table** is the one to use when you want to compare rather than move: sortable
columns, every field visible at once.

**Calendar** places cards with due dates. **Timeline** draws them as bars.
Cards without dates do not appear in either, which is most of them in most
projects, and is why the fifth view exists.

![The sequence view, showing four steps and the critical path](/media/sequence.jpg)

**Sequence** draws the plan as an order rather than as dates. It reads top to
bottom in numbered steps: everything in step 1 can start now, everything in
step 2 waits on step 1, and so on. The **critical path** is highlighted: the
longest chain by size, the one where a slip slips the whole finish. _Critical
path only_ filters to it.

Sequence is computed from dependencies you declare, not guessed. If nothing
declares a dependency, everything is in step 1, which is correct and not very
useful.

## Cards

Open a card in the side inspector, or press the expand control for the full
modal. Both show the same thing.

Status, list, due date, assignees and labels are always visible. Description,
comments, checklists, attachments, plan and history are in sections you can
collapse, so a long description cannot bury the comments underneath it.

### Plan

![A card open beside the sequence, showing its Plan section](/media/card-plan.jpg)

The **Plan** section is where a card takes its place in the sequence:

- **Blocked by** and **Blocks**: pick a relation, pick a card. Cycles are
  refused, with the two cards named.
- **Size**: a unitless estimate. It feeds the critical path. A card with no
  size counts as 1.
- **Milestone**: marks a card as a point worth reaching.

### Comments

`[[@handle]]` notifies that member. `[[ENG-142]]` links to a card,
`[[doc:manual/vision]]` to a document. References are extracted on save, so the
target knows it was mentioned.

## Documents

A tree of Markdown pages in the left rail. Every save makes a version, and you
can read or restore an old one.

![A document with a callout, a table of card references, and its backlinks](/media/documents.jpg)

On top of CommonMark and GFM:

```md
> [!TIP]
> Callouts, in the GitHub style.

:::details Click to expand

Collapsible content, including lists, code and another toggle.

:::

See [[ENG-142]] and [[doc:manual/vision|the vision]].

![[query: space=ENG list="In Progress"]]
```

The last one is a **live embed**: the matching cards render in the page and
stay current. It is how a status page stops being a lie a week after it was
written.

## Search

`Cmd/Ctrl + K` anywhere. It covers card titles and descriptions, comments and
documents in one index, and it is also how you jump to a card by key.

## Notifications

The bell shows what you were mentioned in, assigned to, or are involved in.
Involvement means you commented, were assigned, or created the thing.

Browser notifications must be granted from a real click, so the first time you
enable them Acta asks. Without permission the bell still works, you simply have
to look at it.

## Settings

Four sections, grouped by what you are trying to do.

**People** is who can sign in. Only people can be assigned work or mentioned.

**Labels** is the vocabulary your cards are filed under.

**Automation** is everything that happens without a person, arranged by which
way the work flows: **ingest endpoints** take a URL you paste into a website
form, **connections** let a provider like GitHub push signed events in,
**webhooks** post events back out to your systems, **rules** are Acta reacting
to itself, and **agent tokens** are credentials for a script that acts under
its own name.

**Your account** is the only one that is not administrative, and every member
has it. It holds your own **access tokens**, which let a tool act as _you_
rather than as a bot, and your **connected applications**, which is where you
disconnect something like Claude that you signed in through.

The distinction worth holding on to is whose name ends up in the history. An
access token is you. An agent token, an ingest endpoint and a connection are
each their own identity, which is why a card raised by your contact form says
it came from the contact form rather than from whoever set it up.
