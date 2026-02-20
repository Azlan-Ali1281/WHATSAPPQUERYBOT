/**
 * INTERNAL EMPLOYEES
 * Messages from these users are ignored completely
 */

const EMPLOYEE_IDS = new Set([
    '13026770075820@lid', // Shaheer 2
    '173942400651429@lid', //SHAHEER
    '243159590269138@lid' //ANAS
])

function isEmployee(jid) {
  if (!jid) return false
  return EMPLOYEE_IDS.has(jid)
}

module.exports = {
  isEmployee
}
