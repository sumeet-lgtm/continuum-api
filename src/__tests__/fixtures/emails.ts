/**
 * Canonical email fixtures used across multiple test files.
 * Grouped by expected engine outcome.
 */

export const valid = {
  simple:       'alice@example.com',
  subdomain:    'user@mail.example.com',
  plusTag:      'user+tag@example.com',
  hyphenDomain: 'user@my-company.io',
  numericLocal: 'user123@example.com',
  longLocal:    'a'.repeat(64) + '@example.com',
  dotLocal:     'first.last@example.com',
  specialChars: 'user!#$%&\'*+/=?^_`{|}~@example.com',
  trailingDot:  'user@example.com.',   // FQDN form — valid after normalization
} as const;

export const invalid = {
  noAt:            'userexample.com',
  doubleAt:        'user@@example.com',
  emptyLocal:      '@example.com',
  emptyDomain:     'user@',
  localTooLong:    'a'.repeat(65) + '@example.com',
  domainTooLong:   'user@' + 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64) + '.' + 'd'.repeat(64) + '.com',
  dotStartLocal:   '.user@example.com',
  dotEndLocal:     'user.@example.com',
  doubleDotLocal:  'user..name@example.com',
  numericTld:      'user@example.123',
  singleLabelDomain: 'user@localhost',
  ipLiteral:       'user@[192.168.1.1]',
  emptyLabel:      'user@example..com',
  hyphenStartLabel: 'user@-example.com',
  hyphenEndLabel:   'user@example-.com',
  empty:            '',
  whitespaceOnly:   '   ',
  nonAscii:         'üser@example.com',
} as const;

export const disposable = {
  mailinator:     'test@mailinator.com',
  guerrilla:      'test@guerrillamail.com',
  yopmail:        'test@yopmail.com',
  trashmail:      'test@trashmail.com',
  tenMinute:      'test@10minutemail.com',
  tempmail:       'test@tempmail.com',
  subdomainOfKnown: 'test@sub.mailinator.com',  // subdomain match
} as const;

export const roleAccounts = {
  admin:      'admin@example.com',
  support:    'support@example.com',
  noreply:    'noreply@example.com',
  noReplyDash: 'no-reply@example.com',
  info:       'info@example.com',
  postmaster: 'postmaster@example.com',
  abuse:      'abuse@example.com',
  sales:      'sales@example.com',
  billing:    'billing@example.com',
  help:       'help@example.com',
  contact:    'contact@example.com',
  admin2:     'admin2@example.com',   // numeric suffix
  infoTeam:   'info-team@example.com',  // compound
  // Localized
  kontakt:    'kontakt@example.de',
  soporte:    'soporte@example.es',
  suporte:    'suporte@example.br',
} as const;

export const notRoleAccounts = {
  alice:      'alice@example.com',
  bob123:     'bob123@example.com',
  johndoe:    'john.doe@example.com',
  ceo:        'ceo@example.com',           // not in the role list
  founder:    'founder@example.com',
} as const;
