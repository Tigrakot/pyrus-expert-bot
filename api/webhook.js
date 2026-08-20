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

    // Format phone: 79991722646 → +7 999 172-26-46
    const formatPhone = (val) => {
      if (!val) return '';
      const cleaned = String(val).replace(/\D/g, '');
      if (cleaned.length === 11 && cleaned.startsWith('7')) {
        return `+7 ${cleaned.slice(1, 4)} ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9)}`;
      }
      if (cleaned.length === 10) {
        return `+7 ${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)}-${cleaned.slice(6, 8)}-${cleaned.slice(8)}`;
      }
      return val;
    };

    const getValue = (name) => {
      const f = fieldByName[name.toLowerCase()];
      if (!f) return '';
      // Handle multiple_choice fields
      if (f.value?.choice_names) {
        return f.value.choice_names[0] || '';
      }
      return f.value ?? f.text ?? '';
    };

    const expertName = getValue('фио эксперта') || getValue('фио');
    const location = getValue('местоположение');
    const contacts = formatPhone(getValue('контакты'));
    const status = getValue('статус');
    const priceOutOfCity = parsePrice(getValue('цена выезда за город'));
    const priceDoc = parsePrice(getValue('прием документов'));
    const priceOsmotr = parsePrice(getValue('осмотр тс') || getValue('осмотр'));
    const priceCity = parsePrice(getValue('выезд по городу') || getValue('выезд'));
    const priceAgreement = parsePrice(getValue('соглашение'));

    console.log('Parsed:', { expertName, location, contacts, priceOutOfCity, priceDoc, priceOsmotr, priceCity, priceAgreement });

    if (!expertName) {
      return res.status(200).json({ message: 'No expert name', received: true });
    }

    // Add to catalog 232185 using /diff endpoint with correct format
    // Fields: Эксперт, Местоположение, цена выезда за город, Контакты, Рейтинг/инфо по эксперту
    const expertResp = await fetch('https://api.pyrus.com/v4/catalogs/232185/diff', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        upsert: [{ values: [expertName, location, String(priceOutOfCity), contacts, status || ''] }]
      })
    });
    const expertText = await expertResp.text();
    console.log('Expert response:', expertText.substring(0, 300));

    // Get expenses for this expert to find next sequential number
    const catalogResp = await fetch('https://api.pyrus.com/v4/catalogs/232177', { headers });
    const catalogText = await catalogResp.text();
    const catalogData = JSON.parse(catalogText);
    
    // Find max sequence number for this expert (e.g., "Осадчий-3" → 3)
    let maxSeq = 0;
    if (catalogData.items?.length > 0) {
      for (const item of catalogData.items) {
        const values = item.values || [];
        if (values[3] === expertName) { // Эксперт column
          const idStr = String(values[0] || '');
          const match = idStr.match(/-(\d+)$/);
          if (match) {
            const seq = parseInt(match[1]) || 0;
            if (seq > maxSeq) maxSeq = seq;
          }
        }
      }
    }
    const nextSeq = maxSeq + 1;

    // Create short ID from first letters of each name part (English letters)
    // "Осадчий Владимир Игоревич" → "OVI"
    const expertNameParts = expertName.trim().split(/\s+/);
    const expertShort = expertNameParts.map(part => {
      const firstChar = part[0] || '';
      // Russian to English letter mapping
      const ruToEn = {
        'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'E',
        'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M',
        'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U',
        'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch',
        'Ы': 'Y', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
        'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
        'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
        'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
        'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya'
      };
      return ruToEn[firstChar] || firstChar;
    }).join('');

    // Count how many times this expertShort code already exists in catalog
    // to create unique IDs like OVI-1, OVI-2, etc.
    let codeCount = 0;
    if (catalogData.items?.length > 0) {
      for (const item of catalogData.items) {
        const values = item.values || [];
        if (values[3] === expertName) { // Эксперт column in expenses
          const idStr = String(values[0] || '');
          if (idStr.startsWith(expertShort + '-')) {
            codeCount++;
          }
        }
      }
    }
    const uniqueCode = `${expertShort}-${codeCount + 1}`;

    // Add expenses using /diff endpoint
    const expenses = [
      { id: `${uniqueCode}-1`, name: 'Прием документов', price: priceDoc },
      { id: `${uniqueCode}-2`, name: 'Осмотр ТС', price: priceOsmotr },
      { id: `${uniqueCode}-3`, name: 'Выезд по городу', price: priceCity },
      { id: `${uniqueCode}-4`, name: 'Соглашение', price: priceAgreement }
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
      const commentText = `✅ Эксперт внесён:\n\n📋 ${expertName}\n📍 ${location}\n📱 ${contacts}${status ? `\n🏷️ Статус: ${status}` : ''}\n\n💰 Расходы:\n${expenseText}`;
      
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
