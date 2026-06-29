// v10-fetchjobs-admin
// Netlify serverless proxy for Service Fusion OAuth + API calls
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
      const token = data.token;
      if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'token required' }) };

      const today = new Date();
      const fmt = (d) => {
        const mm = String(d.getMonth()+1).padStart(2,'0');
        const dd = String(d.getDate()).padStart(2,'0');
        return mm+'/'+dd+'/'+d.getFullYear();
      };
      const daysBack = data.daysBack || 7;
      const daysAhead = data.daysAhead || 30;
      const startD = new Date(today); startD.setDate(today.getDate() - daysBack);
      const endD = new Date(today); endD.setDate(today.getDate() + daysAhead);
      const startDate = data.startDate || fmt(startD);
      const endDate = data.endDate || fmt(endD);

      const params = new URLSearchParams({
        'JobsFilterForm[jobStartDateBegin]': startDate,
        'JobsFilterForm[jobStartDateEnd]': endDate,
        'JobsFilterForm[includeJobsWithNoDate]': '1',
        'pageRecord': String(data.pageSize || 200),
        'page': String(data.page || 1),
        'sortField': data.sortField || '',
        'sortOrder': data.sortOrder || '',
      });

      console.log('fetchJobs range:', startDate, '-', endDate);

      const res = await fetch('https://admin.servicefusion.com/jobs/fetchJobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Bearer ' + token,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        body: params.toString(),
      });

      const html = await res.text();
      console.log('fetchJobs status:', res.status, 'bodyLen:', html.length);

      if (res.status !== 200) {
        return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: html.substring(0, 200) }) };
      }

      if (data.debug) {
        return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ rawHtml: html.substring(0, 3000) }) };
      }
      const jobs = parseJobsHtml(html);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs, total: jobs.length })
      };
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

// Cell structure discovered from admin portal:
// Cell 0: SPAN.lead=date, A=job# (+href has obfuscated id), SPAN.muted="$price <br> date (created) <br> JobType"
// Cell 1: SPAN.lead="CustomerName City ST Zip", SPAN.muted="(Street Address)", SPAN(last)="description"
// Cell 2: tech name or "Unassigned"
// Cell 3: status name

function parseJobsHtml(html) {
  const jobs = [];

  // Split into <tr> blocks
  const trParts = html.split(/<tr[\s>]/i);
  for (let i = 1; i < trParts.length; i++) {
    const rowHtml = trParts[i];
    if (rowHtml.includes('<th')) continue;

    // Extract <td> blocks
    const tdBlocks = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM;
    while ((tdM = tdRe.exec(rowHtml)) !== null) {
      tdBlocks.push(tdM[1]);
    }
    if (tdBlocks.length < 4) continue;

    const cell0 = tdBlocks[0];
    const cell1 = tdBlocks[1];
    const cell2 = tdBlocks[2];
    const cell3 = tdBlocks[3];

    const dateSpanM = cell0.match(/<span[^>]*class="lead[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const dateRaw = dateSpanM ? stripTags(dateSpanM[1]).trim() : '';
    const scheduledDate = dateRaw || 'Unscheduled';

    const jobLinkM = cell0.match(/<a[^>]*href="([^"]*jobView[?][^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const jobId = jobLinkM ? (jobLinkM[1].match(/[?&]id=([^&"]+)/) || [])[1] || null : null;
    const jobNumber = jobLinkM ? stripTags(jobLinkM[2]).trim().replace(/^#/, '') : '';

    const mutedSpanM = cell0.match(/<span[^>]*class="muted"[^>]*>([\s\S]*?)<\/span>/i);
    const mutedText = mutedSpanM ? stripTags(mutedSpanM[1]).trim().replace(/\s+/g, ' ') : '';
    const priceM = mutedText.match(/\$([\d,.]+)/);
    const price = priceM ? priceM[0] : '';
    const afterCreated = mutedText.replace(/\$[\d,.]+\s*/g, '').replace(/\d{2}\/\d{2}\/\d{4}[^a-zA-Z]*/g, '').replace(/\(created\)/g, '').trim();
    const jobType = afterCreated || '';

    const custSpanM = cell1.match(/<span[^>]*class="lead"[^>]*>([\s\S]*?)<\/span>/i);
    const custRaw = custSpanM ? stripTags(custSpanM[1]).trim().replace(/\s+/g, ' ') : '';
    const custParts = custRaw.split(/\n|\s{2,}/);
    const customerName = custParts[0] ? custParts[0].trim() : custRaw;
    const cityState = custParts[1] ? custParts[1].trim() : '';

    const cell1MutedM = cell1.match(/<span[^>]*class="muted"[^>]*>([\s\S]*?)<\/span>/i);
    const street = cell1MutedM ? stripTags(cell1MutedM[1]).trim().replace(/[()]/g, '').trim() : '';
    const address = [street, cityState].filter(Boolean).join(', ');

    const allSpansInCell1 = [...cell1.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/gi)];
    let description = '';
    for (let s = allSpansInCell1.length - 1; s >= 0; s--) {
      const attrs = allSpansInCell1[s][1];
      const content = stripTags(allSpansInCell1[s][2]).trim();
      if (!attrs.includes('lead') && !attrs.includes('muted') && !attrs.includes('additional') && content.length > 5) {
        description = content;
        break;
      }
    }

    const tech = stripTags(cell2).trim().replace(/\s+/g, ' ');
    const status = stripTags(cell3).trim().replace(/\s+/g, ' ');

    if (jobId || jobNumber) {
      jobs.push({
        id: jobId || jobNumber,
        number: jobNumber,
        title: jobType || description || 'Job #' + jobNumber,
        customer: customerName,
        address,
        tech,
        status,
        price,
        date: scheduledDate,
        notes: description,
        job_type: jobType,
      });
    }
  }
  return jobs;
}

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
      }
