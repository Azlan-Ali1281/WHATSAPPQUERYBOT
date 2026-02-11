const { parseClientMessageWithAI } = require('./aiClientParser')

async function run() {
  const text = `
VOCCO / LE MERIDIEN
19 FEB TO 04 MAR
DOUBLE

ZILZAL AL NOZLA
12 MAR TO 19 MAR
TRIPLE
`

  const result = await parseClientMessageWithAI(text)
  console.log(JSON.stringify(result, null, 2))
}

run()
