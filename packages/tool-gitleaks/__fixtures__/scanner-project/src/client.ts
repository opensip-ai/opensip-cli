// Sample source with a (non-real) leaked token so a real gitleaks run matches
// the committed golden's second finding. Not a real credential.
export const config = {
  endpoint: 'https://api.example.com',
  token: 'glpat-XXXXXXXXXXXXXXXXXXXX',
};
