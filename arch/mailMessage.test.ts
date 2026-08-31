/**
 * Building a message, and refusing a bad address.
 *
 * Both halves take input a caller partly controls, and both are the kind
 * of thing that is wrong silently: a forged header does not throw, and a
 * bulk send that started as one field looks like a working feature.
 */

import { describe, it, expect } from 'vitest'
import { mime, oneAddress, headerSafe } from '../workers/mcp/src/mailMessage.mjs'

describe('one address, or nothing', () => {
  it('accepts an ordinary address and lowercases it', () => {
    expect(oneAddress('Someone@Example.com')).toBe('someone@example.com')
  })

  it('refuses anything that could become more than one recipient', () => {
    // A comma is how one field becomes a bulk send.
    for (const bad of [
      'a@example.com,c@example.org',
      'a@example.com c@example.org',
      'a@example.com;c@example.org',
      'Name <a@example.com>',
    ]) {
      expect(oneAddress(bad), bad).toBeNull()
    }
  })

  it('refuses a newline, which is how a header is forged', () => {
    expect(oneAddress('a@example.com\nBcc: victim@example.com')).toBeNull()
    expect(oneAddress('a@example.com\r\nSubject: x')).toBeNull()
  })

  it('refuses what is not an address at all', () => {
    for (const bad of ['', '   ', 'nope', 'a@b', '@b.com', 'a@', undefined, null, 42]) {
      expect(oneAddress(bad as never)).toBeNull()
    }
  })
})

describe('header safety', () => {
  it('strips CR and LF, because that is header injection', () => {
    // A subject is the field most likely to carry user text.
    const forged = headerSafe('Ready\r\nBcc: victim@example.com')
    expect(forged).not.toContain('\r')
    expect(forged).not.toContain('\n')
    expect(forged).toBe('Ready Bcc: victim@example.com')
  })
})

describe('the message', () => {
  const base = {
    from: 'no-reply@mail.ontold.com',
    to: 'someone@example.com',
    replyTo: 'hello@ontold.com',
    subject: 'Your film is ready',
    text: 'It finished.',
  }

  it('carries a reply path, because people reply to no-reply', () => {
    expect(mime(base)).toContain('Reply-To: hello@ontold.com')
  })

  it('is plain text when there is no html, with no stray boundary', () => {
    const m = mime(base)
    expect(m).toContain('Content-Type: text/plain; charset="utf-8"')
    expect(m).not.toContain('multipart/alternative')
  })

  it('sends both parts when there is html', () => {
    // An html-only message with no plain-text alternative is a spam
    // signal on its own, and text is what a screen reader gets.
    const m = mime({ ...base, html: '<p>It finished.</p>' })
    expect(m).toContain('multipart/alternative')
    expect(m).toContain('text/plain')
    expect(m).toContain('text/html')
    expect(m).toContain('It finished.')
    expect(m).toContain('<p>It finished.</p>')
  })

  it('uses CRLF line endings, which RFC 5322 requires', () => {
    // A bare LF is accepted by some servers and silently mangles the
    // message on others.
    const m = mime(base)
    expect(m).toContain('\r\n')
    expect(m.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('a subject carrying a newline cannot add a header', () => {
    const m = mime({ ...base, subject: 'Ready\r\nBcc: victim@example.com' })
    const headerBlock = m.split('\r\n\r\n')[0]
    expect(headerBlock).not.toMatch(/^Bcc:/m)
  })
})
