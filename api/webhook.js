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
    console.log('Received webhook:', JSON.stringify(body, null, 2));

    const authResponse = await fetch('https://accounts.pyrus.com/api/v4/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: process.env.PYRUS_BOT_LOGIN,
        security_key: process.env.PYRUS_BOT_KEY
      })
    });

    const authData = await authResponse.json();
    if (!authData.access_token) {
      throw new Error('Failed to authenticate with Pyrus: ' + JSON.stringify(authData));
    }

    const accessToken = authData.access_token;
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    const taskId = body.task_id || body.task?.id;
    
    // Get fields from different possible locations
    let fields = [];
    if (body.task?.form?.fields) {
      fields = body.task.form.fields;
    } else if (body.task?.fields) {
      fields = body.task.fields;
    } else if (body.fields) {
      fields = body.fields;
    }

    // Create lookup by name and by id
    const fieldByName = {};
    const fieldById = {};
    for (const f of fields) {
      if (f.name) fieldByName[f.name.toLowerCase()] = f;
      if (f.id) fieldById[f.id] = f;
    }

    // Parse price - handle "300,00" format
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

    // Exact field names from form
    const expertName = getValue('ФИО Эксперта') || getValue('ФИО');
    const location = getValue('Местоположение');
    const contacts = getValue('Контакты');
    const priceDoc = parsePrice(getValue('Прием документов'));
    const priceOsmotr = parsePrice(getValue('Осмотр ТС') || getValue('Осмотр'));
    const priceCity = parsePrice(getValue('Выезд по городу') || getValue('Выезд'));
    const priceAgreement = parsePrice(getValue('Соглашение'));

    console.log('Parsed values:', { expertName, location, contacts, priceDoc, priceOsmotr, priceCity, priceAgreement });

    if (!expertName) {
      console.log('Missing expert name, skipping...');
      return res.status(200).json({ message: 'No expert name found', received: true });
    }

    // Add expert to catalog 232185
    const expertResponse = await fetch('https://api.pyrus.com/v4/catalogs/232185/items', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        values: [
          expertName,
          location,
          '',
          contacts,
          ''
        ]
      })
    });

    const expertResult = await expertResponse.json();
    console.log('Expert added:', expertResult);

    // Get last ID from catalog 232177
    const catalogResponse = await fetch('https://api.pyrus.com/v4/catalogs/232177', {
      method: 'GET',
      headers
    });
    const catalogData = await catalogResponse.json();
    
    let nextId = 850;
    if (catalogData.items && catalogData.items.length > 0) {
      const maxId = catalogData.items.reduce((max, item) => {
        const id = parseInt(item.values[0]) || 0;
        return id > max ? id : max;
      }, 0);
      nextId = maxId + 1;
    }

    // Add expense items
    const expenseItems = [
      { id: nextId, name: 'Прием документов', price: priceDoc },
      { id: nextId + 1, name: 'Осмотр ТС', price: priceOsmotr },
      { id: nextId + 2, name: 'Выезд по городу', price: priceCity },
      { id: nextId + 3, name: 'Соглашение', price: priceAgreement }
    ];

    const addedExpenses = [];
    for (const expense of expenseItems) {
      if (expense.price > 0) {
        const expenseResponse = await fetch('https://api.pyrus.com/v4/catalogs/232177/items', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            values: [
              String(expense.id),
              expense.name,
              String(expense.price),
              expertName
            ]
          })
        });

        const expenseResult = await expenseResponse.json();
        addedExpenses.push({ id: expense.id, name: expense.name, price: expense.price });
        console.log(`Expense ${expense.id} added`);
      }
    }

    // Add comment to task
    if (taskId) {
      const expenseText = addedExpenses.map(e => `• ${e.name}: ${e.price}₽`).join('\n');
      const commentText = `✅ Эксперт внесён в справочники:\n\n📋 ${expertName}\n📍 ${location}\n📱 ${contacts}\n\n💰 Расходы:\n${expenseText}`;

      await fetch(`https://api.pyrus.com/v4/tasks/${taskId}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: commentText
        })
      });
    }

    return res.status(200).json({
      success: true,
      expert: expertName,
      expenses: addedExpenses
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
