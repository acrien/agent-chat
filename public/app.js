/**
 * app.js — the entry point, and nothing else.
 *
 * WAS 1,420 LINES HOLDING TWELVE SUBJECTS. On 2026-08-09 an edit to the
 * turn-cost display replaced a span between two markers and deleted the
 * heartbeat panel, the jobs page and the window splitter with it — they were
 * neighbours in one file, and a span does not know what it crosses. Nothing
 * here can reach any of them now.
 *
 *   dom         the handles and helpers, and the only place the DOM is named
 *   markdown    a reply rendered as a document
 *   transcript  bubbles, lanes, tool cards, replaying the record
 *   heartbeat   what the out-of-band poller is doing
 *   jobs        what the heartbeat does, and each job's settings
 *   splitter    the handle between the two panels
 *   images      the numbered tray
 *   transport   POSTs out, and the selectors they drive
 *   events      one SSE event in, one change to the page out
 *   boot        wiring and start-up
 */
import './boot.js';
