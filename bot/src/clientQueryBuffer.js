/**
 * CLIENT QUERY BUFFER
 * -------------------
 * Temporarily stores partial client queries
 */

const CLIENT_QUERY_MERGE_WINDOW_MS = 2 * 60 * 1000 // 2 minutes

const buffer = new Map()

function storePartialQuery(groupId, msg, text) {
  buffer.set(groupId, {
    text,
    msg,
    ts: Date.now()
  })
}

function getMergedQueryIfAny(groupId, newText) {
  const prev = buffer.get(groupId)
  if (!prev) return null

  if (Date.now() - prev.ts > CLIENT_QUERY_MERGE_WINDOW_MS) {
    buffer.delete(groupId)
    return null
  }

  const mergedText = `${prev.text}\n${newText}`.trim()
  buffer.delete(groupId)

  return {
    mergedText,
    parentMsg: prev.msg
  }
}

function clearBuffer(groupId) {
  buffer.delete(groupId)
}

module.exports = {
  storePartialQuery,
  getMergedQueryIfAny,
  clearBuffer
}
