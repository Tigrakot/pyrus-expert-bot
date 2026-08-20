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

    // Pyrus auth
    const authResponse = await fetch('https://accounts.pyrus.com/api/v4/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: process.env.PYRUS_LOGIN,
        security_key: process.env.PYRUS_SECURITY_KEY
      })
    });

    const authData = await authResponse.json();
    if (!authData.access_token) {
      throw new Error('Failed to authenticate with Pyrus');
    }

    const accessToken = authData.access_token;
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };

    // Parse form data
    // Form fields: ФИО, Местоположение, Контакты, Статус, Прием документов, Осмотр ТС, Выезд по городу, Соглашение
    const fields = body.task?.form?.fields || body.fields || [];
    
    const getFieldValue = (name) => {
      const field = fields.find(f => 
        (f.name && f.name.toLowerCase().includes(name.toLowerCase())) ||
        (f.field_name && f.field_name.toLowerCase().includes(name.toLowerCase()))
      );
      return field?.value || field?.text || '';
    };

    const expertName = getFieldValue('ФИО') || getFieldValue('фио');
    const location = getFieldValue('Местоположение') || getFieldValue('местоположение');
    const contacts = getFieldValue('Контакты') || getFieldValue('контакты');
    const priceDoc = parseFloat(getFieldValue('Прием документов')) || 0;
    const priceOsmotr = parseFloat(getFieldValue('Осмотр ТС')) || 0;
    const priceCity = parseFloat(getFieldValue('Выезд по городу')) || 0;
    const priceAgreement = parseFloat(getFieldValue('Соглашение')) || 0;

    if (!expertName) {
      return res.status(400).json({ error: 'Missing expert name (ФИО)' });
    }

    console.log('Expert data:', { expertName, location, contacts, priceDoc, priceOsmotr, priceCity, priceAgreement });

    // Add expert to catalog 232185
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

    // Get last ID from catalog 232177 to continue numbering from 850
    const catalogResponse = await fetch('https://api.pyrus.com/v4/catalogs/232177', {
      method: 'GET',
      headers
    });
    const catalogData = await catalogResponse.json();
    
    // Find max ID
    let nextId = 850;
    if (catalogData.items && catalogData.items.length > 0) {
      const maxId = catalogData.items.reduce((max, item) => {
        const id = parseInt(item.values[0]) || 0;
        return id > max ? id : max;
      }, 0);
      nextId = maxId + 1;
    }

    // Add expense items to catalog 232177
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
              String(expense.id),   // ID
              expense.name,         // Вид расходов
              String(expense.price), // Сумма
              expertName            // Эксперт
            ]
          })
        });

        const expenseResult = await expenseResponse.json();
        addedExpenses.push(expenseResult);
        console.log(`Expense ${expense.id} added:`, expenseResult);
      }
    }

    return res.status(200).json({
      success: true,
      expert: expertResult,
      expenses: addedExpenses,
      nextId: nextId + 4
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
