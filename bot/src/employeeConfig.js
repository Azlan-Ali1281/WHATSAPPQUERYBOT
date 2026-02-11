/**
 * INTERNAL EMPLOYEES
 * Messages from these users are ignored completely
 */

const EMPLOYEE_IDS = new Set([
    '13026770075820@lid'
])

function isEmployee(jid) {
  if (!jid) return false
  return EMPLOYEE_IDS.has(jid)
}

module.exports = {
  isEmployee
}
