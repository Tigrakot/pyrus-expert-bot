module.exports = async (req, res) => {
  // CORS headers
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

    // Pyrus auth with bot credentials
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

    // Parse form data from Pyrus webhook
    const taskId = body.task_id || body.task?.id;
    const fields = body.task?.form?.fields || body.task?.fields || body.fields || [];
    
    const getFieldValue = (name) => {
      const field = fields.find(f => 
        (f.name && f.name.toLowerCase().includes(name.toLowerCase())) ||
        (f.field_name && f.field_name.toLowerCase().includes(name.toLowerCase()))
      );
      return field?.value || field?.text || '';
    };

    // Parse price - handle "300,00" format
    const parsePrice = (val) => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        // Remove spaces and replace comma with nothing
        return parseFloat(val.replace(/\s/g, '').replace(',', '.')) || 0;
      }
      return 0;
    };

    const expertName = getFieldValue('ФИО') || getFieldValue('фио') || getFieldValue('ФИО Эксперта');
    const location = getFieldValue('Местоположение') || getFieldValue('местоположение');
    const contacts = getFieldValue('Контакты') || getFieldValue('контакты');
    const priceDoc = parsePrice(getFieldValue('Прием документов') || getFieldValue('Прием документов'));
    const priceOsmotr = parsePrice(getFieldValue('Осмотр ТС') || getFieldValue('Осмотр ТС') || getFieldValue('Осмотр'));
    const priceCity = parsePrice(getFieldValue('Выезд по городу') || getFieldValue('Выезд'));
    const priceAgreement = parsePrice(getFieldValue('Соглашение'));

    if (!expertName) {
      console.log('Missing expert name, skipping...');
      return res.status(200).json({ message: 'No expert name found', received: true });
    }

    console.log('Expert data:', { expertName, location, contacts, priceDoc, priceOsmotr, priceCity, priceAgreement });

    // Add expert to catalog 232185 (Эксперты по осмотру)
    const expertResponse = await fetch('https://api.pyrus.com/v4/catalogs/232185/items', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        values: [
          expertName,           // Эксперт
          location,             // Местоположение
          '',                   // цена выезда за город (not in this form)
          contacts,             // Контакты
          ''                    // Рейтинг/инфо по эксперту
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

    // Add expense items to catalog 232177 (Расходы по эксперту)
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
        console.log(`Expense ${expense.id} added:`, expenseResult);
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
      expenses: addedExpenses,
      nextId: nextId + 4
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
