import { fileLengthLimit } from './checks/file-length-limit.js'
import { noTodoComments } from './checks/no-todo-comments.js'

export const checks = [noTodoComments, fileLengthLimit] as const
export { noTodoComments, fileLengthLimit }

export const metadata = {
  name: '@opensip-tools/checks-universal',
  version: '0.6.1',
  description: 'Cross-language fitness checks shipped with opensip-tools',
}
