// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const twilio = require('twilio');
const mysql = require('mysql');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process'); // Importar spawn
const ytdl = require('ytdl-core');
const { google } = require('googleapis');

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Configuración de Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
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
    auth: process.env.YOUTUBE_API_KEY,
  });

  const response = await youtube.search.list({
    part: 'snippet',
    q: query,
    maxResults: 5, // Puedes ajustar el número de resultados
    type: 'video',
  });

  if (response.data.items.length === 0) {
    throw new Error('No se encontraron resultados');
  }

  // Retornar una lista de videos con id y título
  const videos = response.data.items.map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails.default.url,
  }));

  return videos;
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

// Ruta para descargar audio usando child_process y yt-dlp
app.post('/download-audio', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ message: 'El videoId es requerido' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // Verificar si la URL de YouTube es válida
    if (!ytdl.validateURL(videoUrl)) {
      return res.status(400).json({ message: 'URL de YouTube inválida' });
    }

    // Configurar las opciones de yt-dlp
    const ytDlpProcess = spawn('yt-dlp', [
      '-x', // Extraer audio
      '--audio-format', 'mp3', // Formato de audio
      '-o', '-', // Salida a stdout
      videoUrl
    ]);

    // Manejar errores en el proceso
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
      } else {
        console.log(`Descarga completada para videoId: ${videoId}`);
      }
    });

    // Configurar los encabezados de respuesta
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    // Pipe del stdout de yt-dlp a la respuesta
    ytDlpProcess.stdout.pipe(res);

  } catch (error) {
    console.error('Error en /download-audio:', error.message);
    res.status(500).json({ message: error.message || 'Error al descargar el audio' });
  }
});


// Ruta para registrar un nuevo usuario
app.post('/register', async (req, res) => {
  const { nombreusuario, email, contraseña, telefono } = req.body;

  console.log('Datos recibidos en /register:', req.body); // Log de depuración

  if (!nombreusuario || !email || !contraseña || !telefono) {
    return res.status(400).send('Todos los campos son requeridos');
  }

  try {
    // Verificar si el usuario ya existe
    const checkUserQuery = 'SELECT * FROM login WHERE nombreusuario = ? OR email = ? OR telefono = ?';
    db.query(checkUserQuery, [nombreusuario, email, telefono], (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error del servidor');
      }

      if (results.length > 0) {
        return res.status(400).send('El nombre de usuario, email o teléfono ya están en uso');
      }

      // Insertar el nuevo usuario con contraseña en texto plano
      const insertUserQuery = 'INSERT INTO login (nombreusuario, email, contraseña, telefono) VALUES (?, ?, ?, ?)';
      db.query(insertUserQuery, [nombreusuario, email, contraseña, telefono.toString()], (err, result) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Error al crear el usuario');
        }

        // Generar un código de verificación
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();

        // Insertar el código de verificación
        const insertCodeQuery = 'INSERT INTO verification_codes (telefono, codigo, expiracion) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))';
        db.query(insertCodeQuery, [telefono.toString(), codigo], (err, result) => {
          if (err) {
            console.error(err);
            return res.status(500).send('Error al generar el código de verificación');
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
              res.status(201).send('Usuario creado y código de verificación enviado');
            })
            .catch((error) => {
              console.error(error);
              res.status(500).send('Error al enviar el SMS');
            });
        });
      });
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error del servidor');
  }
});

// Ruta para iniciar sesión con nombre de usuario y contraseña
app.post('/login', (req, res) => {
  const { nombreusuario, contraseña } = req.body;

  console.log('Datos recibidos en /login:', req.body); // Log de depuración

  if (!nombreusuario || !contraseña) {
    return res.status(400).json({ message: 'Nombre de usuario y contraseña son requeridos' });
  }

  const query = 'SELECT * FROM login WHERE nombreusuario = ?';
  db.query(query, [nombreusuario], (err, results) => {
    if (err) {
      console.error('Error en consulta de base de datos:', err);
      return res.status(500).json({ message: 'Error al verificar el usuario' });
    }

    if (results.length === 0) {
      return res.status(400).json({ message: 'Usuario no encontrado' });
    }

    const user = results[0];
    console.log('Usuario encontrado:', user); // Log de depuración

    // Comparar la contraseña en texto plano
    const isMatch = contraseña === user.contraseña;
    console.log('Contraseña coincide:', isMatch); // Log de depuración
    if (!isMatch) {
      return res.status(400).json({ message: 'Contraseña incorrecta' });
    }

    // Generar un token JWT
    const token = jwt.sign({ id: user.id, telefono: user.telefono }, process.env.JWT_SECRET, { expiresIn: '1h' });

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
