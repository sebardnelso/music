const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');
const mysql = require('mysql');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const ytdl = require('ytdl-core');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Configuración de Twilio
const accountSid = 'ACb39291f89d1d31650893afab0325249c';
const authToken = 'c6669450b9fac17a81c689d5f27713f5';
const twilioPhoneNumber = '+16203492492';
const client = twilio(accountSid, authToken);

// Configuración de la base de datos MySQL
const db = mysql.createConnection({
  host: 'ausol.cvme6m2o8um9.us-east-1.rds.amazonaws.com',
  user: 'kalel2016',
  password: 'Kalel2016',
  database: 'harmoniapp',
});

db.connect((err) => {
  if (err) throw err;
  console.log('Conectado a la base de datos MySQL');
});

// Función para buscar videos en YouTube
async function searchYouTube(query) {
  const youtube = google.youtube({
    version: 'v3',
    auth: 'AIzaSyCff0wi4-Jx0WPZmWUnajUxB3nV45QSf0k',
  });

  const response = await youtube.search.list({
    part: 'snippet',
    q: query,
    maxResults: 5,
    type: 'video',
  });

  if (response.data.items.length === 0) {
    throw new Error('No se encontraron resultados');
  }

  return response.data.items.map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails.default.url,
  }));
}

// Ruta para buscar videos en YouTube
app.post('/search-audio', async (req, res) => {
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ message: 'La consulta es requerida' });
  }

  try {
    const videos = await searchYouTube(query);
    res.status(200).json({ videos });
  } catch (error) {
    console.error('Error en /search-audio:', error.message);
    res.status(500).json({ message: error.message || 'Error al buscar el audio' });
  }
});

// Ruta para descargar audio usando yt-dlp
app.post('/download-audio', (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ message: 'El videoId es requerido' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  if (!ytdl.validateURL(videoUrl)) {
    return res.status(400).json({ message: 'URL de YouTube inválida' });
  }

  const ytDlpProcess = spawn('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '-o', '-',
    videoUrl,
  ]);

  ytDlpProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  ytDlpProcess.on('error', (error) => {
    console.error('Error en el proceso de yt-dlp:', error.message);
    res.status(500).json({ message: 'Error al descargar el audio', error: error.message });
  });

  ytDlpProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`yt-dlp proceso finalizó con código ${code}`);
      res.status(500).json({ message: 'Error al descargar el audio' });
    }
  });

  res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
  res.setHeader('Content-Type', 'audio/mpeg');

  ytDlpProcess.stdout.pipe(res);
});

// Ruta para registrar un nuevo usuario
app.post('/register', (req, res) => {
  const { nombreusuario, email, contraseña, telefono } = req.body;

  if (!nombreusuario || !email || !contraseña || !telefono) {
    return res.status(400).send('Todos los campos son requeridos');
  }

  const checkUserQuery = 'SELECT * FROM login WHERE nombreusuario = ? OR email = ? OR telefono = ?';
  db.query(checkUserQuery, [nombreusuario, email, telefono], (err, results) => {
    if (err) return res.status(500).send('Error del servidor');
    if (results.length > 0) return res.status(400).send('El usuario ya existe');

    const insertUserQuery = 'INSERT INTO login (nombreusuario, email, contraseña, telefono) VALUES (?, ?, ?, ?)';
    db.query(insertUserQuery, [nombreusuario, email, contraseña, telefono.toString()], (err) => {
      if (err) return res.status(500).send('Error al crear el usuario');

      const codigo = Math.floor(100000 + Math.random() * 900000).toString();
      const insertCodeQuery = 'INSERT INTO verification_codes (telefono, codigo, expiracion) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))';

      db.query(insertCodeQuery, [telefono.toString(), codigo], (err) => {
        if (err) return res.status(500).send('Error al generar el código de verificación');

        client.messages
          .create({
            body: `Tu código de verificación es: ${codigo}`,
            from: twilioPhoneNumber,
            to: telefono.toString(),
          })
          .then(() => res.status(201).send('Usuario creado y código enviado'))
          .catch(() => res.status(500).send('Error al enviar el SMS'));
      });
    });
  });
});

// Ruta para iniciar sesión
app.post('/login', (req, res) => {
  const { nombreusuario, contraseña } = req.body;

  if (!nombreusuario || !contraseña) {
    return res.status(400).json({ message: 'Nombre de usuario y contraseña son requeridos' });
  }

  const query = 'SELECT * FROM login WHERE nombreusuario = ?';
  db.query(query, [nombreusuario], (err, results) => {
    if (err) return res.status(500).json({ message: 'Error al verificar el usuario' });
    if (results.length === 0) return res.status(400).json({ message: 'Usuario no encontrado' });

    const user = results[0];
    if (contraseña !== user.contraseña) {
      return res.status(400).json({ message: 'Contraseña incorrecta' });
    }

    const token = jwt.sign({ id: user.id, telefono: user.telefono }, 'FSLZ2XGHNZVXPRKLNZ16PBX5', { expiresIn: '1h' });
    res.status(200).json({ token });
  });
});


// Ruta para enviar el código de verificación
app.post('/send-code', (req, res) => {
  const { telefono } = req.body;
  const codigo = Math.floor(100000 + Math.random() * 900000).toString(); // Genera un código de 6 dígitos

  // Guardar el código en la base de datos temporalmente
  const query = 'INSERT INTO verification_codes (telefono, codigo, expiracion) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))';
  db.query(query, [telefono.toString(), codigo], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error al guardar el código de verificación');
    }

    // Enviar el SMS con Twilio
    client.messages
      .create({
        body: `Tu código de verificación es: ${codigo}`,
        from: twilioPhoneNumber,
        to: telefono.toString(),
      })
      .then((message) => {
        console.log(`SMS enviado: SID ${message.sid}`);
        res.status(200).send('Código de verificación enviado');
      })
      .catch((error) => {
        console.error(error);
        res.status(500).send('Error al enviar el SMS');
      });
  });
});

// Ruta para verificar el código
app.post('/verify-code', (req, res) => {
  const { telefono, codigo } = req.body;

  const query = 'SELECT * FROM verification_codes WHERE telefono = ? AND codigo = ? AND expiracion > NOW()';
  db.query(query, [telefono, codigo], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error al verificar el código');
    }

    if (results.length > 0) {
      // Código válido, eliminarlo para evitar reutilización
      const deleteQuery = 'DELETE FROM verification_codes WHERE telefono = ?';
      db.query(deleteQuery, [telefono], (err, result) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Error al eliminar el código');
        }

        // Generar un token JWT
        const token = jwt.sign({ telefono }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({ token });
      });
    } else {
      res.status(400).send('Código de verificación inválido o expirado');
    }
  });
});

// Ruta para registrar o iniciar sesión (opcional)
app.post('/register-or-login', (req, res) => {
  const { telefono, nombreusuario, email } = req.body;

  // Verifica si el usuario ya existe
  const query = 'SELECT * FROM login WHERE telefono = ?';
  db.query(query, [telefono], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error al verificar el usuario');
    }

    if (results.length > 0) {
      // Usuario existe, iniciar sesión
      const user = results[0];
      const token = jwt.sign({ id: user.id, telefono: user.telefono }, process.env.JWT_SECRET, { expiresIn: '1h' });
      res.status(200).json({ token });
    } else {
      // Registrar nuevo usuario
      const insertQuery = 'INSERT INTO login (nombreusuario, email, telefono) VALUES (?, ?, ?)';
      db.query(insertQuery, [nombreusuario, email, telefono], (err, result) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Error al registrar el usuario');
        }

        const token = jwt.sign({ id: result.insertId, telefono }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(201).json({ token });
      });
    }
  });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
