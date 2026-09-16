/**
 * The browser's HTML parser, feeding the shared converter.
 *
 * `DOMParser` is the parser every page the person saved was written for: it
 * closes what was left open, it knows which tags are void, and it never runs
 * a script or loads an image while it parses. The converter in
 * `@nubisco/acta-importers` works on a plain tree so it can run anywhere, and
 * this is the one step between the two.
 */
import type {
  IHtmlConvertResult,
  THtmlNode,
} from '@nubisco/acta-importers/files'
import { htmlToMarkdown } from '@nubisco/acta-importers/files'

/** A DOM node as the converter's tree. Comments and the like are dropped. */
export function toTree(node: Node): THtmlNode | null {
  if (node.nodeType === Node.TEXT_NODE)
    return { kind: 'text', text: node.nodeValue ?? '' }
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const attrs: Record<string, string> = {}
  for (const attr of Array.from(el.attributes))
    attrs[attr.name.toLowerCase()] = attr.value
  const children: THtmlNode[] = []
  // A `<template>` keeps its markup in `content`, which is never shown.
  for (const child of Array.from(el.childNodes)) {
    const converted = toTree(child)
    if (converted) children.push(converted)
  }
  return { kind: 'element', tag: el.localName.toLowerCase(), attrs, children }
}

/** An HTML document or fragment, as Acta markdown. */
export function convertHtml(html: string): IHtmlConvertResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = toTree(doc.documentElement)
  return htmlToMarkdown(root ? [root] : [])
}
