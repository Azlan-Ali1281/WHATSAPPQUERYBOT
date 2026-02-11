/**
 * QUERY LINKER
 * ------------
 * Returns ONLY queryId, never a copy.
 */

const { getOpenQueries } = require('./queryStore')

function linkVendorReply() {
  const openQueries = getOpenQueries()

  // STRICT RULE: only link if ONE open query
  if (openQueries.length === 1) {
    return {
      queryId: openQueries[0].id,
      method: 'SINGLE_OPEN_QUERY'
    }
  }

  return {
    queryId: null,
    method: 'UNLINKED'
  }
}

module.exports = {
  linkVendorReply
}
