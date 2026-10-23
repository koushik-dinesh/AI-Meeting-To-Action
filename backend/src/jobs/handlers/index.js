import { aiExtract } from './aiExtract.js';
import { emailSend } from './emailSend.js';
import { vexaPoll } from './vexaPoll.js';

// Job type -> handler. (Transcript fetching is part of 'vexa.poll'.)
export const handlers = {
  'ai.extract': aiExtract,
  'email.send': emailSend,
  'vexa.poll': vexaPoll,
};
