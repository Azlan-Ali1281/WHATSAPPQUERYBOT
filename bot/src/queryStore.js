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

// ======================================================
// 🧠 CONVERSATIONAL STATE (New Feature)
// ======================================================
const userState = new Map();

function setPendingQuestion(groupId, data) {
    // data = { originalText: "Voco 12 feb", missing: "ROOM_TYPE" }
    userState.set(groupId, { ...data, timestamp: Date.now() });
}

function getPendingQuestion(groupId) {
    const state = userState.get(groupId);
    if (!state) return null;
    
    // Expire after 5 minutes to prevent confusion
    if (Date.now() - state.timestamp > 5 * 60 * 1000) {
        userState.delete(groupId);
        return null;
    }
    return state;
}

function clearPendingQuestion(groupId) {
    userState.delete(groupId);
}

module.exports = {
  createParent,
  getParent,
  createChild,
  getOpenChildren,
  addVendorReply,
  linkVendorMessage,
  getChildByVendorMessage,
  setPendingQuestion,
  getPendingQuestion,
  clearPendingQuestion
}
