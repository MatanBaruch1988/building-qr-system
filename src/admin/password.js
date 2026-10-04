// The password the committee app suggests for a service provider: 8 characters as `xxxx-xxxx`, from an alphabet with no
// look-alike characters (0/o, 1/l/i), because the password gets read out or typed from a message.
export const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const LENGTH = 8

// The largest multiple of the alphabet size that fits in 32 bits. A random value at or above it is drawn again
// (rejection sampling): a plain `value % size` over all 2^32 values would make the first characters of the alphabet a
// little more likely than the others.
const LIMIT = Math.floor(2 ** 32 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length

/** `random` fills a Uint32Array with cryptographically secure values (the browser's crypto.getRandomValues). */
export function generatePassword(random = (array) => crypto.getRandomValues(array)) {
  const chars = []
  while (chars.length < LENGTH) {
    for (const value of random(new Uint32Array(LENGTH - chars.length))) {
      if (value < LIMIT) chars.push(PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length])
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}
