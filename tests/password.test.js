// The password that the committee app suggests for a service provider (src/admin/password.js).
import { describe, it, expect } from 'vitest'
import { generatePassword, PASSWORD_ALPHABET } from '../src/admin/password.js'

const SHAPE = new RegExp(`^[${PASSWORD_ALPHABET}]{4}-[${PASSWORD_ALPHABET}]{4}$`)

/** A stand-in for crypto.getRandomValues that hands out the given values in order and records every request. */
function scripted(values) {
  const asked = []
  let next = 0
  const random = (array) => {
    asked.push(array.length)
    for (let i = 0; i < array.length; i++) array[i] = values[next++]
    return array
  }
  return { random, asked }
}

describe('the suggested password', () => {
  it('is 8 characters of the alphabet without look-alikes, as xxxx-xxxx', () => {
    for (let i = 0; i < 200; i++) expect(generatePassword()).toMatch(SHAPE)
    expect(PASSWORD_ALPHABET).not.toMatch(/[01ilo]/)
  })

  it('maps each random value to one character', () => {
    const { random } = scripted([0, 1, 2, 3, 30, 31, 32, 61])
    // 0 -> a, 1 -> b, 2 -> c, 3 -> d, 30 -> the last character, 31 -> a again, 32 -> b, 61 -> the last one
    const last = PASSWORD_ALPHABET.at(-1)
    expect(generatePassword(random)).toBe(`abcd-${last}ab${last}`)
  })

  it('draws again for a value in the top, incomplete round of the alphabet, so every character is equally likely', () => {
    const size = PASSWORD_ALPHABET.length
    const limit = Math.floor(2 ** 32 / size) * size
    // The first draw has two values that are refused (the limit itself and the largest 32-bit value): two more are asked for.
    const { random, asked } = scripted([0, limit, 1, 2 ** 32 - 1, 2, 3, 4, 5, 6, 7])
    expect(generatePassword(random)).toBe('abcd-efgh')
    expect(asked).toEqual([8, 2])
  })

  it('accepts the largest value below the limit', () => {
    const size = PASSWORD_ALPHABET.length
    const limit = Math.floor(2 ** 32 / size) * size
    const { random, asked } = scripted([limit - 1, 0, 0, 0, 0, 0, 0, 0])
    expect(generatePassword(random)).toBe(`${PASSWORD_ALPHABET.at(-1)}aaa-aaaa`)
    expect(asked).toEqual([8])
  })
})
