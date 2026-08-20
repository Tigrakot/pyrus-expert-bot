module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    console.log('Webhook received, task_id:', body.task_id || body.task?.id);

    // Auth
    const authResponse = await fetch('https://accounts.pyrus.com/api/v4/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: process.env.PYRUS_BOT_LOGIN,
        security_key: process.env.PYRUS_BOT_KEY
      })
    });

    const authText = await authResponse.text();
    let authData;
    try {
      authData = JSON.parse(authText);
    } catch (e) {
      throw new Error('Auth failed: ' + authText.substring(0, 200));
    }
    
    if (!authData.access_token) {
      throw new Error('No access token: ' + JSON.stringify(authData));
    }

    const accessToken = authData.access_token;
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    const taskId = body.task_id || body.task?.id;
    
    let fields = [];
    if (body.task?.form?.fields) fields = body.task.form.fields;
    else if (body.task?.fields) fields = body.task.fields;
    else if (body.fields) fields = body.fields;

    const fieldByName = {};
    for (const f of fields) {
      if (f.name) fieldByName[f.name.toLowerCase()] = f;
    }

    const parsePrice = (val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        return parseFloat(val.replace(/\s/g, '').replace(',', '.')) || 0;
      }
      return 0;
    };

    const getValue = (name) => {
      const f = fieldByName[name.toLowerCase()];
      return f?.value ?? f?.text ?? '';
    };

    const expertName = getValue('фио эксперта') || getValue('фио');
    const location = getValue('местоположение');
    const contacts = getValue('контакты');
    const priceDoc = parsePrice(getValue('прием документов'));
    const priceOsmotr = parsePrice(getValue('осмотр тс') || getValue('осмотр'));
    const priceCity = parsePrice(getValue('выезд по городу') || getValue('выезд'));
    const priceAgreement = parsePrice(getValue('соглашение'));

    console.log('Parsed:', { expertName, location, contacts, priceDoc, priceOsmotr, priceCity, priceAgreement });

    if (!expertName) {
      return res.status(200).json({ message: 'No expert name', received: true });
    }

    // Add to catalog 232185 using /diff endpoint with correct format
    const expertResp = await fetch('https://api.pyrus.com/v4/catalogs/232185/diff', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        upsert: [{ values: [expertName, location, '', contacts, ''] }]
      })
    });
    const expertText = await expertResp.text();
    console.log('Expert response:', expertText.substring(0, 300));

    // Get last ID from catalog 232177
    const catalogResp = await fetch('https://api.pyrus.com/v4/catalogs/232177', { headers });
    const catalogText = await catalogResp.text();
    const catalogData = JSON.parse(catalogText);
    
    let nextId = 850;
    if (catalogData.items?.length > 0) {
      const maxId = catalogData.items.reduce((max, item) => {
        const id = parseInt(item.values[0]) || 0;
        return id > max ? id : max;
      }, 0);
      nextId = maxId + 1;
    }

    // Add expenses using /diff endpoint
    const expenses = [
      { id: nextId, name: 'Прием документов', price: priceDoc },
      { id: nextId + 1, name: 'Осмотр ТС', price: priceOsmotr },
      { id: nextId + 2, name: 'Выезд по городу', price: priceCity },
      { id: nextId + 3, name: 'Соглашение', price: priceAgreement }
    ];

    const addedExpenses = [];
    for (const e of expenses) {
      if (e.price > 0) {
        const resp = await fetch('https://api.pyrus.com/v4/catalogs/232177/diff', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            upsert: [{ values: [String(e.id), e.name, String(e.price), expertName] }]
          })
        });
        const text = await resp.text();
        console.log(`Expense ${e.id} response:`, text.substring(0, 200));
        addedExpenses.push(e);
      }
    }

    // Comment to task
    if (taskId) {
      const expenseText = addedExpenses.map(e => `• ${e.name}: ${e.price}₽`).join('\n');
      const commentText = `✅ Эксперт внесён:\n\n📋 ${expertName}\n📍 ${location}\n📱 ${contacts}\n\n💰 Расходы:\n${expenseText}`;
      
      await fetch(`https://api.pyrus.com/v4/tasks/${taskId}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: commentText })
      });
    }

    return res.status(200).json({ success: true, expert: expertName, expenses: addedExpenses });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
