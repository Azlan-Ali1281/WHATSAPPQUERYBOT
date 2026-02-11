/**
 * QUERY STORE (PHASE 7C - REPLY AWARE)
 * ----------------------------------
 * Tracks which WhatsApp message belongs to which child query
 */

const parents = new Map()
const children = new Map()
const vendorMessageToChild = new Map()

function createParent({ clientGroupId, originalMessage }) {
  const id = 'P-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

  const parent = {
    id,
    clientGroupId,
    originalMessage,
    createdAt: Date.now(),
    childIds: []
  }

  parents.set(id, parent)
  return parent
}

function getParent(id) {
  return parents.get(id)
}

function createChild({ parentId, parsed }) {
  const id = 'C-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

  const child = {
    id,
    parentId,
    parsed,

    status: 'OPEN',
    createdAt: Date.now(),

    vendorReplies: [],
    bestRate: null,

    firstReplyAt: null,
    hasSentInitialRate: false,
    vendorMessageIds: [] // messages sent to vendors
  }

  children.set(id, child)
  parents.get(parentId).childIds.push(id)

  return child
}

function linkVendorMessage(childId, messageId) {
  vendorMessageToChild.set(messageId, childId)
}

function getChildByVendorMessage(messageId) {
  const childId = vendorMessageToChild.get(messageId)
  return childId ? children.get(childId) : null
}

function getOpenChildren() {
  return Array.from(children.values()).filter(c => c.status === 'OPEN')
}

function addVendorReply(childId, reply) {
  const child = children.get(childId)
  if (!child || child.status !== 'OPEN') return null

  child.vendorReplies.push(reply)

  if (!child.bestRate || reply.rate < child.bestRate.rate) {
    child.bestRate = reply
    return reply
  }

  return null
}

module.exports = {
  createParent,
  getParent,
  createChild,
  getOpenChildren,
  addVendorReply,
  linkVendorMessage,
  getChildByVendorMessage
}
