const express = require('express');
const bodyParser = require('body-parser');
const { sequelize } = require('./model')
const { getProfile } = require('./middleware/getProfile')
const { Op, col, fn, literal } = require("sequelize");
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize);
app.set('models', sequelize.models);
const { Job, Contract, Profile } = sequelize.models;


/**
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { id } = req.params
    const contract = await Contract.findOne({ where: { ClientId: req.profile.id, id } });
    if (!contract) return res.status(404).end()
    res.json(contract)
})

/**
 * @returns all non terminated contracts
 */
app.get('/contracts', getProfile, async (req, res) => {
    const role = req.profile.type === 'client' ? 'ClientId' : 'ContractorId'
    const contracts = await Contract.findAll({ where: { [role]: req.profile.id, status: { [Op.not]: 'terminated' } } });
    if (contracts.length == 0) return res.status(404).end()
    res.json(contracts)
})

/**
 * @returns all unpaid jobs
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get('models')
    const role = req.profile.type === 'client' ? '$Contract.ClientId$' : '$Contract.ContractorId$'
    const jobs = await Job.findAll({
        include: { model: Contract },
        where: { paid: null, [role]: req.profile.id, '$Contract.status$': { [Op.not]: 'terminated' } }
    });
    if (jobs.length == 0) return res.status(404).end()
    res.json(jobs)
})

/**
 * @abstract pay for a job
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    if (req.profile.type !== 'client') return res.status(403).send('Not allowed.');
    const { job_id } = req.params

    const getContract = async () => await Contract.findOne({
        include: [
            { model: Job, where: { id: job_id, paid: null } }, { model: Profile, as: 'Client' }, { model: Profile, as: 'Contractor' }
        ],
        where: { ClientId: req.profile.id }
    });

    const contract = await getContract();
    if (!contract) return res.status(404).send('Job not found or already paid.');

    if (contract.Jobs[0].price > req.profile.balance) return res.status(404).send('Unsufficient funds.')

    await Promise.all([
        await Profile.update(
            { balance: contract.Client.balance - contract.Jobs[0].price },
            { where: { id: contract.Client.id } }
        ),
        await Profile.update(
            { balance: contract.Contractor.balance + contract.Jobs[0].price },
            { where: { id: contract.Contractor.id } }
        ),
        await Job.update(
            { paid: true, paymentDate: (new Date).toISOString() },
            { where: { id: job_id } }
        ),
    ])

    res.json(await getContract())
})

/**
 * @abstract deposits money into the the the balance of a client
 */
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const client = await Profile.findOne({ where: { id: req.params.userId, type: 'client' } });
    if (!client) return res.status(404).send('Client not found.');
    const { amount } = req.body;

    const contracts = await Contract.findAll({
        include: [
            {
                model: Job,
                where: { paid: null },
                attributes: [
                    'price',
                    [fn('sum', col('price')), 'total_amount'],
                ],
            }, { model: Profile, as: 'Client' }
        ],
        where: {
            ClientId: client.id
        }
    });

    if (amount > contracts[0].Jobs[0].total_amount * 0.25) return res.status(403).send('The amount is higher than allowed.');

    await Profile.update(
        { balance: client.balance + amount },
        { where: { id: client.id } }
    )

    const clientUpdated = await Profile.findOne({ where: { id: client.id } })

    res.json(clientUpdated)
})


/**
 * @abstract returns the profession that earned the most money
 */
app.get('/admin/best-profession', getProfile, async (req, res) => {
    const { start, end } = req.query;

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (startDate > endDate) return res.status(400).send('Invalid date range.');

    const contracts = await Contract.findAll({
        include: [
            {
                model: Job,
                where: {
                    paid: true,
                    paymentDate: {
                        [Op.between]: [startDate, endDate]
                    }
                },
                attributes: [
                    [fn('sum', col('price')), 'total_amount'],
                ],
            }, {
                model: Profile,
                as: 'Contractor',
            }
        ],
        group: ['Contractor.profession']
    });

    const groupedRes = await contracts.map(x => ({ [x.dataValues.Contractor.profession]: x.dataValues.Jobs[0].dataValues.total_amount }))

    res.json(groupedRes)
})

/**
 * @abstract returns the profession that earned the most money
 */
app.get('/admin/best-clients', getProfile, async (req, res) => {
    const { start, end, limit } = req.query;

    const startDate = new Date(start);
    const endDate = new Date(end);
    const pageLimit = limit || 2;

    if (startDate > endDate) return res.status(400).send('Invalid date range.');

    const contracts = await Contract.findAll({
        include: [
            {
                model: Job,
                where: {
                    paid: true,
                    paymentDate: {
                        [Op.between]: [startDate, endDate]
                    }
                },
                attributes: [
                    [fn('sum', col('price')), 'total_amount'],
                ],
            }, {
                model: Profile,
                as: 'Client',
                attributes: [
                    'id',
                    [literal("firstName || ' ' || lastName"), 'fullName'],
                ],
            }
        ],
        group: ['Client.id']
    });

    const groupedRes = await contracts.map(x => ({
        id: x.dataValues.ClientId,
        fullName: x.dataValues.Client.dataValues.fullName,
        paid: x.dataValues.Jobs[0].dataValues.total_amount
    }))

    res.json(groupedRes)
})

module.exports = app;
