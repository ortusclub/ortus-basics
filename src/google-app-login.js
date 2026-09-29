import {randomBytes} from 'node:crypto';
// A fresh Google callback must complete the attempt belonging to this browser.
// A saved Sheets connection alone never grants an unauthenticated app session.
export function installGoogleAppLogin(app, {connection, issueSession, setOperator, now = Date.now}) {
  const attempts = new Map();
  const cookie = 'ortus_google_login';
  const options = {httpOnly:true,sameSite:'strict',path:'/api/auth/google',maxAge:300000};
  function sameOrigin(req,res) {
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) {
      res.status(403).json({error:'Invalid sign-in origin'}); return false;
    }
    return true;
  }
  app.post('/api/auth/google/start', async (req,res) => {
    if (!sameOrigin(req,res)) return;
    for (const [id,entry] of attempts) if (entry.expires <= now()) attempts.delete(id);
    const old = req.cookies?.[cookie]; if (old) attempts.delete(old);
    const id = randomBytes(32).toString('base64url');
    const entry = {expires:now()+300000,email:null}; attempts.set(id,entry);
    try {
      const url = await connection.begin({onAuthenticated: user => {
        if (attempts.get(id) === entry && entry.expires > now()) entry.email = user.email;
      }});
      res.cookie(cookie,id,options);
      res.json({url});
    } catch { attempts.delete(id); res.status(503).json({error:'Could not start Google sign-in. Please try again.'}); }
  });
  app.post('/api/auth/google/complete', async (req,res) => {
    if (!sameOrigin(req,res)) return;
    const id = req.cookies?.[cookie]; const entry = attempts.get(id);
    if (!entry || entry.expires <= now()) {
      if (id) attempts.delete(id);
      return res.status(401).json({error:'Sign-in expired. Please sign in with Google again.'});
    }
    if (!entry.email) {
      const error = connection.status().error;
      return res.json({pending:true,...(error ? {error} : {})});
    }
    attempts.delete(id); // one-use completion, including simultaneous polling
    try {
      setOperator(entry.email);
      await issueSession(res,entry.email);
      res.clearCookie(cookie,{path:options.path});
      res.json({ok:true,email:entry.email});
    } catch { res.status(500).json({error:'Could not save your app sign-in. Please try again.'}); }
  });
}
