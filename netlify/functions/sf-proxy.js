// v11-session-login
// Netlify serverless proxy for Service Fusion OAuth + admin session login
// fetchJobs does a full credential login to get a session cookie, then calls the admin portal
exports.handler = async (event) => {
  const { httpMethod, queryStringParameters, headers, body } = event;
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  if (httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  if (httpMethod === 'POST') {
    let data;
    try { data = JSON.parse(body || '{}'); } catch(e) { return { statusCode: 400, headers: CORS, body: 'Invalid JSON' }; }

    if (data.action === 'exchange') {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: data.code,
        client_id: data.client_id,
        client_secret: data.client_secret,
        redirect_uri: data.redirect_uri,
      });
      const res = await fetch('https://api.servicefusion.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const text = await res.text();
      console.log('exchange status:', res.status, 'body:', text);
      return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: text };
    }

    if (data.action === 'refresh') {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token,
        client_id: data.client_id,
        client_secret: data.client_secret,
      });
      const res = await fetch('https://api.servicefusion.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const text = await res.text();
      console.log('refresh status:', res.status, 'body:', text);
      return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: text };
    }

    if (data.action === 'fetchJobs') {
      // Credentials: from request body, or from Netlify env vars
      const sfCompany  = data.sfCompany  || process.env.SF_COMPANY  || 'towergenerator';
      const sfUsername = data.sfUsername || process.env.SF_USERNAME;
      const sfPassword = data.sfPassword || process.env.SF_PASSWORD;

      if (!sfUsername || !sfPassword) {
        return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'SF credentials required. Set SF_USERNAME + SF_PASSWORD in Netlify env vars.' }) };
      }

      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

      // ââ Step 1: GET login page â CSRF token + initial cookies ââââââââââââââ
      const pageRes = await fetch('https://auth.servicefusion.com/auth/login', {
        headers: { Accept: 'text/html', 'User-Agent': UA },
      });
      const pageHtml = await pageRes.text();
      const pageCookies = getSetCookies(pageRes);

      const tokenMatch = pageHtml.match(/name="_token"\s+value="([^"]++"/);
      if (!tokenMatch) {
        return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'No CSRF token on SF login page', preview: pageHtml.substring(0, 300) }) };
      }
      const csrfToken = tokenMatch[1];
      console.log('CSRF ok, pageCookies:', pageCookies.length);

      // ââ Step 2: POST credentials ââââââââââââââââââââââââââââââââââââââââââââ
      const loginRes = await fetch('https://auth.servicefusion.com/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieStr(pageCookies),
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': UA,
          Referer: 'https://auth.servicefusion.com/auth/login',
        },
        body: new URLSearchParams({ _token: csrfToken, company: sfCompany, uid: sfUsername, pwd: sfPassword }).toString(),
        redirect: 'manual',
      });
      const loginCookies = getSetCookies(loginRes);
      console.log('login status:', loginRes.status, 'loginCookies:', loginCookies.length);

      // status 302 = success; 200 = probably wrong credentials (redisplays form)
      if (loginRes.status === 200) {
        const errHtml = await loginRes.text();
        return { statusCode: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'SF login failed â check SF_USERNAME / SF_PASSWORD', preview: errHtml.substring(0, 200) }) };
      }

      // Merge cookies
      const jar = mergeCookies([...pageCookies, ...loginCookies]);

      // ââ Step 3: Follow redirect to pick up any admin-side cookies ââââââââââ
      const location = loginRes.headers.get('location');
      if (location) {
        const adminRes = await fetch(location, {
          headers: { Cookie: jarStr(jar), 'User-Agent': UA, Accept: 'text/html' },
          redirect: 'manual',
        });
        mergeCookies(getSetCookies(adminRes), jar);
        console.log('admin redirect status:', adminRes.status, 'extra cookies:', getSetCookies(adminRes).length);
      }

      // ââ Step 4: POST fetchJobs ââââââââââââââââââââââââââââââââââââââââââââââ
      const today = new Date();
      const fmt = (d) => String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+'/'+d.getFullYear();
      const daysBack  = data.daysBack  || 7;
      const daysAhead = data.daysAhead || 30;
      const startD = new Date(today); startD.setDate(today.getDate() - daysBack);
      const endD   = new Date(today);   endD.setDate(today.getDate() + daysAhead);
      const startDate = data.startDate || fmt(startD);
      const endDate   = data.endDate   || fmt(endD);

      const params = new URLSearchParams({
        'JobsFilterForm[jobStartDateBegin]':     startDate,
        'JobsFilterForm[jobStartDateEnd]':       endDate,
        'JobsFilterForm[includeJobsWithNoDate]': '1',
        pageRecord: String(data.pageSize || 200),
        page:       String(data.page || 1),
        sortField:  data.sortField || '',
        sortOrder:  data.sortOrder || '',
      });
      console.log('fetchJobs range:', startDate, '-', endDate);

      const fetchRes = await fetch('https://admin.servicefusion.com/jobs/fetchJobs', {
        method: 'POST',
        headers: {
          'Content-Type':     'application/x-www-form-urlencoded',
          Cookie:             jarStr(jar),
          'X-Requested-With': 'XMLHttpRequest',
          Accept:             'text/html,application/xhtml+xml,*/*',
          'User-Agent':       UA,
          Referer:            'https://admin.servicefusion.com/jobs',
        },
        body: params.toString(),
      });

      const html = await fetchRes.text();
      console.log('fetchJobs status:', fetchRes.status, 'bodyLen:', html.length);

      if (fetchRes.status !== 200) {
        return { statusCode: fetchRes.status, headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: html.substring(0, 300) }) };
      }
      if (data.debug) {
        return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rawHtml: html.substring(0, 4000) }) };
      }
      const jobs = parseJobsHtml(html);
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs, total: jobs.length }) };
    }

    return { statusCode: 400, headers: CORS, body: 'Unknown action' };
  }

  if (httpMethod === 'GET') {
    const { _path = '/jobs', ...rest } = queryStringParameters || {};
    const qs = new URLSearchParams(rest).toString();
    const targetUrl = 'https://api.servicefusion.com/v1' + _path + (qs ? '?' + qs : '');
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: headers.authorization || headers.Authorization || '',
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: text };
  }

  return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
};

// ââ Cookie helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const h = res.headers.get('set-cookie');
  return h ? [h] : [];
}
// Merge array of Set-Cookie strings into a jar object (optionally into existing jar)
function mergeCookies(cookies, jar = {}) {
  cookies.forEach(c => {
    const kv = c.split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.substring(0, eq).trim()] = kv.substring(eq + 1).trim();
  });
  return jar;
}
function jarStr(jar)   { return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join
