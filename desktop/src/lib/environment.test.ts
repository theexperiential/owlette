import { describe, expect, it } from 'vitest'
import { environmentFromConfig, environmentToken, hostOf } from './environment'
import type { OwletteConfig } from './owletteConfig'

/** Config.json is `Record<string, unknown>` at the type level; cast once here. */
const config = (value: Record<string, unknown>): OwletteConfig => value as OwletteConfig

describe('hostOf', () => {
  it('keeps the host of a real pairing url, path and query dropped', () => {
    expect(hostOf('https://dev.owlette.app/add?code=x')).toBe('dev.owlette.app')
    expect(hostOf('https://owlette.app/add')).toBe('owlette.app')
  })

  it('keeps the port, which is all that separates two local origins', () => {
    expect(hostOf('http://localhost:3000/add')).toBe('localhost:3000')
  })

  it('returns "" for the empty string agentCli defaults pairingUrl to', () => {
    expect(hostOf('')).toBe('')
  })

  it('returns "" rather than throwing on a value that is not a url', () => {
    expect(hostOf('not a url')).toBe('')
    expect(hostOf('dev.owlette.app/add')).toBe('')
  })

  it('tolerates a missing field', () => {
    expect(hostOf(null)).toBe('')
    expect(hostOf(undefined)).toBe('')
  })
})

describe('environmentToken', () => {
  it('badges dev', () => {
    expect(environmentToken('dev.owlette.app')).toBe('dev')
  })

  it('says nothing about production — an unbadged app is the real fleet', () => {
    expect(environmentToken('owlette.app')).toBeNull()
  })

  it('names anything else outright, so a local or preview build is obvious', () => {
    expect(environmentToken('localhost:3000')).toBe('localhost:3000')
    expect(environmentToken('owlette-git-branch.vercel.app')).toBe('owlette-git-branch.vercel.app')
  })

  it('has nothing to say about an unknown host', () => {
    expect(environmentToken('')).toBeNull()
  })
})

describe('environmentFromConfig', () => {
  it('reads the api_base the service actually calls', () => {
    expect(environmentFromConfig(config({ firebase: { api_base: 'https://dev.owlette.app/api' } }))).toBe('dev')
    expect(environmentFromConfig(config({ firebase: { api_base: 'https://owlette.app/api' } }))).toBeNull()
  })

  it('falls back to the top-level environment string', () => {
    expect(environmentFromConfig(config({ environment: 'development' }))).toBe('dev')
    expect(environmentFromConfig(config({ environment: 'production' }))).toBeNull()
  })

  it('lets api_base win when the config carries both', () => {
    // The service dials api_base; a stale `environment` label must not outrank it.
    expect(
      environmentFromConfig(
        config({ environment: 'production', firebase: { api_base: 'https://dev.owlette.app/api' } }),
      ),
    ).toBe('dev')
    expect(
      environmentFromConfig(
        config({ environment: 'development', firebase: { api_base: 'https://owlette.app/api' } }),
      ),
    ).toBeNull()
  })

  it('says nothing before the first config read lands', () => {
    expect(environmentFromConfig(null)).toBeNull()
  })

  it('says nothing when the config carries neither field', () => {
    expect(environmentFromConfig(config({}))).toBeNull()
    expect(environmentFromConfig(config({ firebase: { enabled: true, site_id: 'default_site' } }))).toBeNull()
  })

  it('ignores fields of the wrong shape instead of throwing', () => {
    expect(environmentFromConfig(config({ firebase: 'nope', environment: 'development' }))).toBe('dev')
    expect(environmentFromConfig(config({ firebase: { api_base: 42 }, environment: 'development' }))).toBe('dev')
    expect(environmentFromConfig(config({ environment: 7 }))).toBeNull()
  })

  it('falls through to environment when api_base is present but unusable', () => {
    expect(environmentFromConfig(config({ firebase: { api_base: '' }, environment: 'development' }))).toBe('dev')
    expect(
      environmentFromConfig(config({ firebase: { api_base: 'not a url' }, environment: 'development' })),
    ).toBe('dev')
  })
})
