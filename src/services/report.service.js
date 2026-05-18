// src/services/report.service.js
// Read-only service — ZERO writes, ZERO transactions
'use strict';

const mongoose = require('mongoose');
const Customer = require('../models/Customer.model');
const PigmyAccount = require('../models/PigmyAccount.model');
const SavingAccount = require('../models/SavingAccount.model');
const Collection = require('../models/Collection.model');
const LoanAccount = require('../models/LoanAccount.model');
const Transaction = require('../models/Transaction.model');
const LedgerEntry = require('../models/LedgerEntry.model');
const LedgerAccount = require('../models/LedgerAccount.model');
const User = require('../models/User.model');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const AppConfig = require('../models/AppConfig.model');
const { startOfDay, endOfDay } = require('../utils/dateHelpers');
const { LOAN_STATUS, COLLECTION_STATUS, LEDGER_ACCOUNT_TYPES, ROLES } = require('../config/constants');

// toObjId — local wrapper; dateHelpers version may not always accept string safely
const toObjId = (id) => new mongoose.Types.ObjectId(id);


// ─────────────────────────────────────────────────────────
// 1. ADMIN DASHBOARD — All KPIs in one call
// ─────────────────────────────────────────────────────────
const getDashboard = async () => {
    // Use system business date — NOT wall-clock new Date().
    // In microfinance, the business date may lag the calendar date after EOD
    // procedures. Using new Date() would show wrong "today's collections".
    const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
    const today = rawBusinessDate ? new Date(rawBusinessDate) : new Date();
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);
    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    lastMonthEnd.setHours(23, 59, 59, 999);

    const [customerStats, accountStats, // FIXED: was Account.aggregate — model doesn't exist
        todayCollection, monthCollection, lastMonthCollection, loanStats, overdueStats, kycPending, recentCollections,] = await Promise.all([

        // ── Customer KPIs ─────────────────────────────────
        Customer.aggregate(
            [
                {
                    $match: {
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: null,
                        total: {
                            $sum: 1
                        },
                        active: {
                            $sum: {
                                $cond: ['$isActive', 1, 0]
                            }
                        },
                        kycVerified: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$kycStatus', 'kyc_verified']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        newThisMonth: {
                            $sum: {
                                $cond: [
                                    {
                                        $gte: ['$createdAt', thisMonthStart]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                },
            ]
        ),

        // ── Pigmy Account KPIs ────────────────────────────
        // FIXED: was Account.aggregate — should be PigmyAccount
        PigmyAccount.aggregate(
            [
                {
                    $match: {
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: null,
                        totalAccounts: {
                            $sum: 1
                        },
                        activeAccounts: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'active']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        frozenAccounts: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'frozen']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        closedAccounts: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'closed']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        totalBalancePaise: {
                            $sum: '$balanceInPaise'
                        }
                    }
                },
            ]
        ),

        // ── Today's Collections ───────────────────────────
        Collection.aggregate(
            [
                {
                    $match: {
                        collectionDate: {
                            $gte: todayStart,
                            $lte: todayEnd
                        },
                        status: COLLECTION_STATUS.COLLECTED,
                        isDeleted: false,
                        isReversed: false
                    }
                }, {
                    $group: {
                        _id: null,
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        },
                        uniqueAgents: {
                            $addToSet: '$agent'
                        },
                        uniqueCustomers: {
                            $addToSet: '$customer'
                        }
                    }
                },
            ]
        ),

        // ── This Month Collections ────────────────────────
        Collection.aggregate(
            [
                {
                    $match: {
                        collectionDate: {
                            $gte: thisMonthStart,
                            $lte: todayEnd
                        },
                        status: COLLECTION_STATUS.COLLECTED,
                        isDeleted: false,
                        isReversed: false
                    }
                }, {
                    $group: {
                        _id: null,
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        }
                    }
                },
            ]
        ),

        // ── Last Month Collections (MoM comparison) ───────
        Collection.aggregate(
            [
                {
                    $match: {
                        collectionDate: {
                            $gte: lastMonthStart,
                            $lte: lastMonthEnd
                        },
                        status: COLLECTION_STATUS.COLLECTED,
                        isDeleted: false,
                        isReversed: false
                    }
                }, {
                    $group: {
                        _id: null,
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        }
                    }
                },
            ]
        ),

        // ── Loan Portfolio KPIs ───────────────────────────
        LoanAccount.aggregate(
            [
                {
                    $match: {
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: null,
                        totalLoans: {
                            $sum: 1
                        },
                        activeLoans: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'active']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        overdueLoans: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'overdue']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        closedLoans: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'closed']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        writtenOffLoans: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: ['$status', 'written_off']
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        totalDisbursedPaise: {
                            $sum: '$principalAmountInPaise'
                        },
                        totalOutstandingPaise: {
                            $sum: {
                                $cond: [
                                    {
                                        $in: [
                                            '$status',
                                            [
                                                'active', 'overdue'
                                            ]
                                        ]
                                    },
                                    '$outstandingBalanceInPaise',
                                    0,
                                ]
                            }
                        },
                        totalRepaidPaise: {
                            $sum: '$totalPaidInPaise'
                        }
                    }
                },
            ]
        ),

        // ── Overdue Loan Alert ─────────────────────────────
        LoanAccount.aggregate(
            [
                {
                    $match: {
                        status: LOAN_STATUS.OVERDUE,
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: null,
                        count: {
                            $sum: 1
                        },
                        totalOutstanding: {
                            $sum: '$outstandingBalanceInPaise'
                        },
                        totalPenalty: {
                            $sum: '$penaltyAmountInPaise'
                        }
                    }
                },
            ]
        ),

        // ── KYC Pending Count ─────────────────────────────
        Customer.countDocuments(
            {kycStatus: 'documents_submitted', isDeleted: false}
        ),

        // ── Recent 5 Collections (activity feed) ──────────
        Collection.find(
            {isDeleted: false, isReversed: false}
        ).select('receiptNumber amountInPaise customer agent collectionDate createdAt').populate('customer', 'name customerCode').populate('agent', 'name agentCode').sort(
            {createdAt: -1}
        ).limit(5).lean(),
    ]);

    const thisMonthTotal = monthCollection[0] ?. totalPaise || 0;
    const lastMonthTotal = lastMonthCollection[0] ?. totalPaise || 0;
    const momGrowth = lastMonthTotal > 0 ? (((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100).toFixed(1) : null;

    const cStats = customerStats[0] || {};
    const aStats = accountStats[0] || {};
    const lStats = loanStats[0] || {};
    const oStats = overdueStats[0] || {};
    const tColl = todayCollection[0] || {};

    return {
        generatedAt: new Date().toISOString(),

        customers: {
            total: cStats.total || 0,
            active: cStats.active || 0,
            kycVerified: cStats.kycVerified || 0,
            kycPending,
            newThisMonth: cStats.newThisMonth || 0
        },

        pigmyAccounts: {
            // FIXED: key renamed from 'savings' → 'pigmyAccounts'
            totalAccounts: aStats.totalAccounts || 0,
            activeAccounts: aStats.activeAccounts || 0,
            frozenAccounts: aStats.frozenAccounts || 0,
            closedAccounts: aStats.closedAccounts || 0,
            totalBalanceInPaise: aStats.totalBalancePaise || 0,
            totalBalanceInRupees: (
                (aStats.totalBalancePaise || 0) / 100
            ).toFixed(2)
        },

        todayCollection: {
            totalInPaise: tColl.totalPaise || 0,
            totalInRupees: (
                (tColl.totalPaise || 0) / 100
            ).toFixed(2),
            count: tColl.count || 0,
            activeAgents: (tColl.uniqueAgents || []).length,
            customersServed: (tColl.uniqueCustomers || []).length
        },

        monthCollection: {
            totalInPaise: thisMonthTotal,
            totalInRupees: (thisMonthTotal / 100).toFixed(2),
            count: monthCollection[0] ?. count || 0,
            momGrowthPercent: momGrowth,
            trend: momGrowth === null ? 'N/A' : Number(momGrowth) >= 0 ? '↑' : '↓'
        },

        loans: {
            total: lStats.totalLoans || 0,
            active: lStats.activeLoans || 0,
            overdue: lStats.overdueLoans || 0,
            closed: lStats.closedLoans || 0,
            writtenOff: lStats.writtenOffLoans || 0,
            totalDisbursedInRup: (
                (lStats.totalDisbursedPaise || 0) / 100
            ).toFixed(2),
            totalOutstandingInRup: (
                (lStats.totalOutstandingPaise || 0) / 100
            ).toFixed(2),
            totalRepaidInRup: (
                (lStats.totalRepaidPaise || 0) / 100
            ).toFixed(2)
        },

        overdueAlert: {
            count: oStats.count || 0,
            totalOutstandingInRup: (
                (oStats.totalOutstanding || 0) / 100
            ).toFixed(2),
            totalPenaltyInRup: (
                (oStats.totalPenalty || 0) / 100
            ).toFixed(2)
        },

        recentActivity: recentCollections.map((c) => ({
            receipt: c.receiptNumber,
            customer: c.customer ?. name,
            agent: c.agent ?. name,
            amountInRup: (c.amountInPaise / 100).toFixed(2),
            time: c.createdAt
        }))
    };
};


// ─────────────────────────────────────────────────────────
// 2. COLLECTION REPORT (date range — daily breakdown)
// ─────────────────────────────────────────────────────────
const getCollectionReport = async ({
    fromDate,
    toDate,
    agentId,
    requestingUserRole,
    requestingUserId
}) => {
    const from = startOfDay(fromDate || new Date());
    const to = endOfDay(toDate || new Date());

    if (from > to) 
        throw new ApiError(400, 'fromDate must be before toDate');
    


    const match = {
        collectionDate: {
            $gte: from,
            $lte: to
        },
        isDeleted: false,
        isReversed: false
    };

    if (requestingUserRole === ROLES.AGENT) {
        match.agent = toObjId(requestingUserId);
    } else if (agentId) {
        match.agent = toObjId(agentId);
    }

    const [dailyBreakdown, summary, agentBreakdown] = await Promise.all([

        // ── Day-by-day breakdown ──────────────────────────
        Collection.aggregate(
            [
                {
                    $match: match
                }, {
                    $group: {
                        _id: {
                            year: {
                                $year: '$collectionDate'
                            },
                            month: {
                                $month: '$collectionDate'
                            },
                            day: {
                                $dayOfMonth: '$collectionDate'
                            }
                        },
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        },
                        agents: {
                            $addToSet: '$agent'
                        }
                    }
                }, {
                    $project: {
                        _id: 0,
                        date: {
                            $dateFromParts: {
                                year: '$_id.year',
                                month: '$_id.month',
                                day: '$_id.day'
                            }
                        },
                        totalInPaise: '$totalPaise',
                        totalInRupees: {
                            $divide: ['$totalPaise', 100]
                        },
                        count: '$count',
                        agentCount: {
                            $size: '$agents'
                        }
                    }
                }, {
                    $sort: {
                        date: 1
                    }
                },
            ]
        ),

        // ── Period total ──────────────────────────────────
        Collection.aggregate(
            [
                {
                    $match: match
                }, {
                    $group: {
                        _id: null,
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        },
                        uniqueCustomers: {
                            $addToSet: '$customer'
                        },
                        uniqueAgents: {
                            $addToSet: '$agent'
                        }
                    }
                },
            ]
        ),

        // ── Per-agent breakdown (admin only) ──────────────
        requestingUserRole !== ROLES.AGENT ? Collection.aggregate(
            [
                {
                    $match: match
                },
                {
                    $group: {
                        _id: '$agent',
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        count: {
                            $sum: 1
                        },
                        uniqueCustomers: {
                            $addToSet: '$customer'
                        }
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'agentInfo'
                    }
                },
                {
                    $project: {
                        agentName: {
                            $arrayElemAt: ['$agentInfo.name', 0]
                        },
                        agentCode: {
                            $arrayElemAt: ['$agentInfo.agentCode', 0]
                        },
                        totalInPaise: '$totalPaise',
                        totalInRupees: {
                            $divide: ['$totalPaise', 100]
                        },
                        count: '$count',
                        customersServed: {
                            $size: '$uniqueCustomers'
                        }
                    }
                }, {
                    $sort: {
                        totalInPaise: -1
                    }
                },
            ]
        ) : [],
    ]);

    const s = summary[0] || {};

    return {
        period: {
            from: from.toLocaleDateString('en-IN'),
            to: to.toLocaleDateString('en-IN')
        },
        summary: {
            totalInPaise: s.totalPaise || 0,
            totalInRupees: (
                (s.totalPaise || 0) / 100
            ).toFixed(2),
            totalCollections: s.count || 0,
            uniqueCustomers: (s.uniqueCustomers || []).length,
            uniqueAgents: (s.uniqueAgents || []).length
        },
        dailyBreakdown,
        agentBreakdown
    };
};


// ─────────────────────────────────────────────────────────
// 3. AGENT PERFORMANCE REPORT
// ─────────────────────────────────────────────────────────
const getAgentPerformance = async ({fromDate, toDate}) => {
    const from = startOfDay(fromDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to = endOfDay(toDate || new Date());

    const agents = await User.find({role: ROLES.AGENT, isActive: true, isDeleted: false}).select('_id name phone agentCode area').lean();

    const agentIds = agents.map((a) => a._id);

    const [collectionStats, assignedAccounts] = await Promise.all([

        Collection.aggregate(
            [
                {
                    $match: {
                        agent: {
                            $in: agentIds
                        },
                        collectionDate: {
                            $gte: from,
                            $lte: to
                        },
                        isDeleted: false,
                        isReversed: false,
                        status: COLLECTION_STATUS.COLLECTED
                    }
                }, {
                    $group: {
                        _id: '$agent',
                        totalPaise: {
                            $sum: '$amountInPaise'
                        },
                        totalCount: {
                            $sum: 1
                        },
                        uniqueCustomers: {
                            $addToSet: '$customer'
                        },
                        workingDays: {
                            $addToSet: {
                                $dateToString: {
                                    format: '%Y-%m-%d',
                                    date: '$collectionDate'
                                }
                            }
                        }
                    }
                },
            ]
        ),

        // FIXED: was Account.aggregate — should be PigmyAccount
        PigmyAccount.aggregate(
            [
                {
                    $match: {
                        assignedAgent: {
                            $in: agentIds
                        },
                        status: 'active',
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: '$assignedAgent',
                        totalAccounts: {
                            $sum: 1
                        },
                        expectedDailyPaise: {
                            $sum: '$dailyDepositAmountInPaise'
                        }
                    }
                },
            ]
        ),
    ]);

    const statsMap = Object.fromEntries(collectionStats.map((s) => [s._id.toString(), s]));
    const accountsMap = Object.fromEntries(assignedAccounts.map((a) => [a._id.toString(), a]));

    const performance = agents.map((agent) => {
        const key = agent._id.toString();
        const stats = statsMap[key] || {};
        const accs = accountsMap[key] || {};
        const totalDays = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;
        const workingDays = (stats.workingDays || []).length;
        const totalCollected = stats.totalPaise || 0;
        const expectedPerDay = accs.expectedDailyPaise || 0;
        const expectedTotal = expectedPerDay * totalDays;
        const collectionRate = expectedTotal > 0 ? ((totalCollected / expectedTotal) * 100).toFixed(1) : '0.0';

        return {
            agentId: agent._id,
            name: agent.name,
            agentCode: agent.agentCode,
            phone: agent.phone,
            assignedAccounts: accs.totalAccounts || 0,
            expectedDailyInRup: (expectedPerDay / 100).toFixed(2),
            period: {
                totalDays,
                workingDays,
                attendanceRate: totalDays > 0 ? `${
                    ((workingDays / totalDays) * 100).toFixed(1)
                }%` : '0%'
            },
            collections: {
                totalInPaise: totalCollected,
                totalInRupees: (totalCollected / 100).toFixed(2),
                count: stats.totalCount || 0,
                customersServed: (stats.uniqueCustomers || []).length,
                expectedInRup: (expectedTotal / 100).toFixed(2),
                collectionRate: `${collectionRate}%`
            }
        };
    });

    performance.sort((a, b) => parseFloat(b.collections.collectionRate) - parseFloat(a.collections.collectionRate));

    return {
        period: {
            from: from.toLocaleDateString('en-IN'),
            to: to.toLocaleDateString('en-IN')
        },
        totalAgents: agents.length,
        performance
    };
};


// ─────────────────────────────────────────────────────────
// 4. LOAN PORTFOLIO REPORT
// ─────────────────────────────────────────────────────────
const getLoanPortfolio = async () => {
    const [portfolio, planBreakdown, disbursedMonthly] = await Promise.all([

        // ── Status breakdown ──────────────────────────────
        LoanAccount.aggregate(
            [
                {
                    $match: {
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: '$status',
                        count: {
                            $sum: 1
                        },
                        totalPrincipalPaise: {
                            $sum: '$principalAmountInPaise'
                        },
                        totalOutstandingPaise: {
                            $sum: '$outstandingBalanceInPaise'
                        },
                        totalRepaidPaise: {
                            $sum: '$totalPaidInPaise'
                        },
                        totalPenaltyPaise: {
                            $sum: '$penaltyAmountInPaise'
                        }
                    }
                },
            ]
        ),

        // ── Breakdown by loan plan ────────────────────────
        LoanAccount.aggregate(
            [
                {
                    $match: {
                        isDeleted: false,
                        status: {
                            $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE]
                        }
                    }
                }, {
                    $group: {
                        _id: '$loanPlan',
                        count: {
                            $sum: 1
                        },
                        totalPrincipal: {
                            $sum: '$principalAmountInPaise'
                        },
                        totalOutstanding: {
                            $sum: '$outstandingBalanceInPaise'
                        },
                        // FIXED: removed avgEmi: { $avg: '$emiAmountInPaise' }
                        // Field doesn't exist — flat-rate loan system has no EMI
                    }
                }, {
                    $lookup: {
                        from: 'loanplans',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'plan'
                    }
                }, {
                    $project: {
                        planName: {
                            $arrayElemAt: ['$plan.planName', 0]
                        },
                        durationMonths: {
                            $arrayElemAt: ['$plan.durationMonths', 0]
                        },
                        count: 1,
                        totalPrincipalInRup: {
                            $divide: ['$totalPrincipal', 100]
                        },
                        totalOutstandingInRup: {
                            $divide: ['$totalOutstanding', 100]
                        },
                        // FIXED: avgEmiInRup removed
                    }
                },
            ]
        ),

        // ── Monthly disbursement trend (last 6 months) ────
        LoanAccount.aggregate(
            [
                {
                    $match: {
                        disbursedAt: {
                            $gte: new Date(new Date().setMonth(new Date().getMonth() - 6))
                        },
                        isDeleted: false
                    }
                }, {
                    $group: {
                        _id: {
                            year: {
                                $year: '$disbursedAt'
                            },
                            month: {
                                $month: '$disbursedAt'
                            }
                        },
                        count: {
                            $sum: 1
                        },
                        totalPrincipal: {
                            $sum: '$principalAmountInPaise'
                        }
                    }
                }, {
                    $project: {
                        _id: 0,
                        year: '$_id.year',
                        month: '$_id.month',
                        count: 1,
                        totalInRupees: {
                            $divide: ['$totalPrincipal', 100]
                        }
                    }
                }, {
                    $sort: {
                        year: 1,
                        month: 1
                    }
                },
            ]
        ),
    ]);

    const byStatus = {};
    for (const row of portfolio) {
        byStatus[row._id] = {
            count: row.count,
            principalInRupees: (row.totalPrincipalPaise / 100).toFixed(2),
            outstandingInRupees: (row.totalOutstandingPaise / 100).toFixed(2),
            repaidInRupees: (row.totalRepaidPaise / 100).toFixed(2),
            penaltyInRupees: (row.totalPenaltyPaise / 100).toFixed(2)
        };
    }

    const totalActive = (byStatus['active'] ?. count || 0) + (byStatus['overdue'] ?. count || 0);
    const overdueCount = byStatus['overdue'] ?. count || 0;
    const npaRatio = totalActive > 0 ? ((overdueCount / totalActive) * 100).toFixed(2) : '0.00';

    return {
        generatedAt: new Date().toISOString(),
        byStatus,
        npaRatio: `${npaRatio}%`,
        byPlan: planBreakdown,
        disbursementTrend: disbursedMonthly
    };
};


// ─────────────────────────────────────────────────────────
// 5. OVERDUE / NPA REPORT
// ─────────────────────────────────────────────────────────
const getOverdueReport = async ({agentId} = {}) => {
    const match = {
        status: {
            $in: [LOAN_STATUS.OVERDUE, LOAN_STATUS.ACTIVE]
        },
        maturityDate: {
            $lt: new Date()
        },
        isDeleted: false
    };

    // FIXED: was 'savingsAccount' — this project uses 'pigmyAccount'
    const overdueLoans = await LoanAccount.find(match).select('loanAccountNumber customer pigmyAccount principalAmountInPaise outstandingBalanceInPaise penaltyAmountInPaise maturityDate disbursedAt status durationMonths').populate('customer', 'name phone customerCode').populate('pigmyAccount', 'accountNumber assignedAgent').lean();

    // Filter by agent if provided
    const filtered = agentId ? overdueLoans.filter((l) => l.pigmyAccount ?. assignedAgent ?. toString() === agentId.toString()) : overdueLoans;

    const today = new Date();

    const report = filtered.map((loan) => {
            const daysOverdue = Math.floor((today - new Date(loan.maturityDate)) / (1000 * 60 * 60 * 24));
            const aging = daysOverdue <= 30 ? '0-30 days' : daysOverdue<= 60 ? '31-60 days'    :
            daysOverdue <= 90 ? '61-90 days'    : '90+ days (NPA)';

        return {
            loanAccountNumber:   loan.loanAccountNumber, customer: {
                name:         loan.customer?.name, phone:        loan.customer?.phone, customerCode: loan.customer?.customerCode, }, principalInRupees:   (loan.principalAmountInPaise    / 100).toFixed(2), outstandingInRupees: (loan.outstandingBalanceInPaise  / 100).toFixed(2), penaltyInRupees:     (loan.penaltyAmountInPaise       / 100).toFixed(2), maturityDate:        loan.maturityDate, daysOverdue, aging, };
    });

    // ── Aging summary buckets ─────────────────────────────
    const agingBuckets = {
        '0-30 days':      { count: 0, totalOutstandingPaise: 0 }, '31-60 days':     { count: 0, totalOutstandingPaise: 0 }, '61-90 days':     { count: 0, totalOutstandingPaise: 0 }, '90+ days (NPA)': { count: 0, totalOutstandingPaise: 0 }, };

    for (const r of report) {
        const loan = filtered.find((l) => l.loanAccountNumber === r.loanAccountNumber);
        agingBuckets[r.aging].count++;
        agingBuckets[r.aging].totalOutstandingPaise += loan?.outstandingBalanceInPaise || 0;
    }

    const agingSummary = Object.entries(agingBuckets).map(([bucket, data]) =>({
                bucket,
                count: data.count,
                totalOutstandingInRupees: (data.totalOutstandingPaise / 100).toFixed(2)
            })
        );

        return {
            generatedAt: new Date().toISOString(),
            totalOverdue: report.length,
            totalOutstandingInRupees: (filtered.reduce((s, l) => s + l.outstandingBalanceInPaise, 0) / 100).toFixed(2),
            agingSummary,
            overdueLoans: report.sort(
                (a, b) => b.daysOverdue - a.daysOverdue
            )
        };
    };


    // ─────────────────────────────────────────────────────────
    // 6. TRIAL BALANCE (from LedgerEntry — double-entry)
    // ─────────────────────────────────────────────────────────
    const getTrialBalance = async ({asOfDate} = {}) => {
        const asOf = asOfDate ? endOfDay(asOfDate) : endOfDay(new Date());

        const [ledgerAccounts, entryTotals] = await Promise.all([
            LedgerAccount.find(
                {isActive: true}
            ).lean(),

            LedgerEntry.aggregate(
                [
                    {
                        $match: {
                            // FIXED: was createdAt — must use businessDate for accounting cutoffs
                            // FIXED: removed isDeleted:false — LedgerEntry has no isDeleted field
                            //        (immutable double-entry records are never deleted)
                            businessDate: {
                                $lte: asOf
                            }
                        }
                    }, {
                        $group: {
                            _id: '$ledgerAccount',
                            totalDebits: {
                                $sum: '$debitInPaise'
                            },
                            totalCredits: {
                                $sum: '$creditInPaise'
                            }
                        }
                    },
                ]
            ),
        ]);

        const totalsMap = Object.fromEntries(entryTotals.map((e) => [e._id.toString(), e]));

        let grandTotalDebits = 0;
        let grandTotalCredits = 0;

        const rows = ledgerAccounts.map((acc) => {
            const totals = totalsMap[acc._id.toString()] || {
                totalDebits: 0,
                totalCredits: 0
            };
            const netBalance = acc.normalBalance === 'debit' ? totals.totalDebits - totals.totalCredits : totals.totalCredits - totals.totalDebits;

            grandTotalDebits += totals.totalDebits;
            grandTotalCredits += totals.totalCredits;

            return {
                accountCode: acc.code,
                accountName: acc.name,
                accountType: acc.type,
                normalBalance: acc.normalBalance,
                debitInRupees: (totals.totalDebits / 100).toFixed(2),
                creditInRupees: (totals.totalCredits / 100).toFixed(2),
                netBalanceInRupees: (Math.abs(netBalance) / 100).toFixed(2),
                side: netBalance >= 0 ? acc.normalBalance : acc.normalBalance === 'debit' ? 'credit' : 'debit'
            };
        });

        const isBalanced = grandTotalDebits === grandTotalCredits;

        return {
            asOf: asOf.toLocaleDateString('en-IN'),
            isBalanced,
            integrityStatus: isBalanced ? '✅ Balanced' : '❌ IMBALANCED — INVESTIGATE',
            grandTotals: {
                totalDebitsInRupees: (grandTotalDebits / 100).toFixed(2),
                totalCreditsInRupees: (grandTotalCredits / 100).toFixed(2),
                differenceInRupees: (Math.abs(grandTotalDebits - grandTotalCredits) / 100).toFixed(2)
            },
            assets: rows.filter((r) => r.accountType === LEDGER_ACCOUNT_TYPES.ASSET),
            liabilities: rows.filter((r) => r.accountType === LEDGER_ACCOUNT_TYPES.LIABILITY),
            income: rows.filter((r) => r.accountType === LEDGER_ACCOUNT_TYPES.INCOME),
            expenses: rows.filter((r) => r.accountType === LEDGER_ACCOUNT_TYPES.EXPENSE)
        };
    };


    // ─────────────────────────────────────────────────────────
    // 7. PROFIT & LOSS REPORT
    // ─────────────────────────────────────────────────────────
    const getPnlReport = async ({fromDate, toDate}) => {
        const from = startOfDay(fromDate || new Date(new Date().getFullYear(), 0, 1));
        const to = endOfDay(toDate || new Date());

        const [incomeAccounts, expenseAccounts] = await Promise.all([
            LedgerAccount.find(
                {type: LEDGER_ACCOUNT_TYPES.INCOME, isActive: true}
            ).lean(),
            LedgerAccount.find(
                {type: LEDGER_ACCOUNT_TYPES.EXPENSE, isActive: true}
            ).lean(),
        ]);

        const incomeIds = incomeAccounts.map((a) => a._id);
        const expenseIds = expenseAccounts.map((a) => a._id);

        const [incomeEntries, expenseEntries] = await Promise.all([

            LedgerEntry.aggregate(
                [
                    {
                        $match: {
                            ledgerAccount: {
                                $in: incomeIds
                            },
                            // FIXED: was createdAt — use businessDate for P&L period filtering
                            // FIXED: removed isDeleted:false — LedgerEntry has no isDeleted field
                            businessDate: {
                                $gte: from,
                                $lte: to
                            }
                        }
                    }, {
                        $group: {
                            _id: '$ledgerAccount',
                            totalCredits: {
                                $sum: '$creditInPaise'
                            }, // Income = credit side
                            totalDebits: {
                                $sum: '$debitInPaise'
                            }
                        }
                    },
                ]
            ),

            LedgerEntry.aggregate(
                [
                    {
                        $match: {
                            ledgerAccount: {
                                $in: expenseIds
                            },
                            // FIXED: was createdAt — use businessDate for P&L period filtering
                            // FIXED: removed isDeleted:false — LedgerEntry has no isDeleted field
                            businessDate: {
                                $gte: from,
                                $lte: to
                            }
                        }
                    }, {
                        $group: {
                            _id: '$ledgerAccount',
                            totalDebits: {
                                $sum: '$debitInPaise'
                            }, // Expense = debit side
                            totalCredits: {
                                $sum: '$creditInPaise'
                            }
                        }
                    },
                ]
            ),
        ]);

        const incomeMap = Object.fromEntries(incomeEntries.map((e) => [e._id.toString(), e]));
        const expenseMap = Object.fromEntries(expenseEntries.map((e) => [e._id.toString(), e]));

        let totalIncomeInPaise = 0;
        let totalExpenseInPaise = 0;

        const incomeRows = incomeAccounts.map((acc) => {
            const e = incomeMap[acc._id.toString()] || {};
            const net = (e.totalCredits || 0) - (e.totalDebits || 0);
            totalIncomeInPaise += net;
            return {
                name: acc.name,
                code: acc.code,
                amountInRupees: (net / 100).toFixed(2)
            };
        });

        const expenseRows = expenseAccounts.map((acc) => {
            const e = expenseMap[acc._id.toString()] || {};
            const net = (e.totalDebits || 0) - (e.totalCredits || 0);
            totalExpenseInPaise += net;
            return {
                name: acc.name,
                code: acc.code,
                amountInRupees: (net / 100).toFixed(2)
            };
        });

        const netProfitInPaise = totalIncomeInPaise - totalExpenseInPaise;

        return {
            period: {
                from: from.toLocaleDateString('en-IN'),
                to: to.toLocaleDateString('en-IN')
            },
            income: {
                items: incomeRows,
                totalInRupees: (totalIncomeInPaise / 100).toFixed(2)
            },
            expenses: {
                items: expenseRows,
                totalInRupees: (totalExpenseInPaise / 100).toFixed(2)
            },
            netProfit: {
                inRupees: (Math.abs(netProfitInPaise) / 100).toFixed(2),
                type: netProfitInPaise >= 0 ? 'Profit' : 'Loss',
                indicator: netProfitInPaise >= 0 ? '📈' : '📉'
            }
        };
    };


    // ─────────────────────────────────────────────────────────
    // 8. CASH POSITION REPORT
    // ─────────────────────────────────────────────────────────
    const getCashPosition = async () => { // FIXED: was code:'CASH_IN_HAND' — seed data uses code:'1001' (see LedgerAccount.model.js)
        const cashAccount = await LedgerAccount.findOne({code: '1001', isActive: true}).lean();
        if (! cashAccount) 
            throw new ApiError(500, 'Cash in Hand ledger account (1001) not found');
        


        const [entries, todayEntries] = await Promise.all([

            // ── All-time cash position ────────────────────────
            // FIXED: removed isDeleted:false — LedgerEntry has no isDeleted field
            LedgerEntry.aggregate(
                [
                    {
                        $match: {
                            ledgerAccount: cashAccount._id
                        }
                    }, {
                        $group: {
                            _id: null,
                            totalDebits: {
                                $sum: '$debitInPaise'
                            },
                            totalCredits: {
                                $sum: '$creditInPaise'
                            }
                        }
                    },
                ]
            ),

            // ── Today's cash movement ─────────────────────────
            // FIXED: was createdAt — use businessDate for correct daily cut-off
            // FIXED: removed isDeleted:false — LedgerEntry has no isDeleted field
            LedgerEntry.aggregate(
                [
                    {
                        $match: {
                            ledgerAccount: cashAccount._id,
                            businessDate: {
                                $gte: startOfDay(new Date()),
                                $lte: endOfDay(new Date())
                            }
                        }
                    }, {
                        $group: {
                            _id: null,
                            cashIn: {
                                $sum: '$debitInPaise'
                            },
                            cashOut: {
                                $sum: '$creditInPaise'
                            }
                        }
                    },
                ]
            ),
        ]);

        const totals = entries[0] || {
            totalDebits: 0,
            totalCredits: 0
        };
        const today = todayEntries[0] || {
            cashIn: 0,
            cashOut: 0
        };
        const cashInHand = totals.totalDebits - totals.totalCredits; // Asset = DR − CR

        return {
            asOf: new Date().toISOString(),
            cashInHandInRupees: (Math.max(0, cashInHand) / 100).toFixed(2),
            today: {
                cashInInRupees: (today.cashIn / 100).toFixed(2),
                cashOutInRupees: (today.cashOut / 100).toFixed(2),
                netInRupees: (
                    (today.cashIn - today.cashOut) / 100
                ).toFixed(2)
            }
        };
    };


    // ─────────────────────────────────────────────────────────
    // 9. CUSTOMER REPORT
    // ─────────────────────────────────────────────────────────
    const getCustomerReport = async ({
        fromDate,
        toDate,
        kycStatus,
        assignedAgent,
        page = 1,
        limit = 50
    }) => {
        const filter = {
            isDeleted: false
        };
        if (kycStatus) 
            filter.kycStatus = kycStatus;
        

        if (assignedAgent) 
            filter.assignedAgent = toObjId(assignedAgent);
        

        if (fromDate || toDate) {
            filter.createdAt = {};
            if (fromDate) 
                filter.createdAt.$gte = startOfDay(fromDate);
            

            if (toDate) 
                filter.createdAt.$lte = endOfDay(toDate);
            

        }

        const safeLimit = Math.min(Number(limit), 100);
        const skip = (Number(page) - 1) * safeLimit;

        const [customers, total] = await Promise.all([
            Customer.find(filter).select('customerCode name phone kycStatus isActive assignedAgent createdAt').populate('assignedAgent', 'name agentCode').skip(skip).limit(safeLimit).sort(
                {createdAt: -1}
            ),
            Customer.countDocuments(filter),
        ]);

        return {
            customers,
            pagination: {
                total,
                page: Number(page),
                limit: safeLimit,
                totalPages: Math.ceil(total / safeLimit)
            }
        };
    };


    // ─────────────────────────────────────────────────────────
    // 10. DAILY TRANSACTION REPORT
    // ─────────────────────────────────────────────────────────
    const getDailyTransactionReport = async ({ date, type, page = 1, limit = 50 }) => {
        const filter = { isDeleted: false };
        if (date) {
            filter.businessDate = {
                $gte: startOfDay(date),
                $lte: endOfDay(date)
            };
        } else {
            const today = new Date();
            filter.businessDate = {
                $gte: startOfDay(today),
                $lte: endOfDay(today)
            };
        }

        if (type) filter.type = type;

        const safeLimit = Math.min(Number(limit), 100);
        const skip = (Number(page) - 1) * safeLimit;

        const [transactions, total] = await Promise.all([
            Transaction.find(filter)
                .populate('customer', 'name customerCode phone')
                .populate('performedBy', 'name role')
                .populate('fromSavingAccount', 'accountNumber')
                .populate('toSavingAccount', 'accountNumber')
                .populate('fromPigmyAccount', 'accountNumber')
                .populate('toPigmyAccount', 'accountNumber')
                .populate('fromLoanAccount', 'loanAccountNumber')
                .populate('toLoanAccount', 'loanAccountNumber')
                .skip(skip)
                .limit(safeLimit)
                .sort({ businessDate: -1, createdAt: -1 }),
            Transaction.countDocuments(filter)
        ]);

        return {
            transactions,
            pagination: {
                total,
                page: Number(page),
                limit: safeLimit,
                totalPages: Math.ceil(total / safeLimit)
            }
        };
    };


    // ─────────────────────────────────────────────────────────
    // 11. LEDGER HISTORY REPORT
    // ─────────────────────────────────────────────────────────
    const getLedgerHistory = async ({ ledgerCode, fromDate, toDate, page = 1, limit = 50 }) => {
        const ledgerAccount = await LedgerAccount.findOne({ code: ledgerCode, isActive: true }).lean();
        if (!ledgerAccount) throw new ApiError(404, `Ledger account (${ledgerCode}) not found`);

        const filter = { ledgerAccount: ledgerAccount._id };
        if (fromDate || toDate) {
            filter.businessDate = {};
            if (fromDate) filter.businessDate.$gte = startOfDay(fromDate);
            if (toDate) filter.businessDate.$lte = endOfDay(toDate);
        }

        const safeLimit = Math.min(Number(limit), 100);
        const skip = (Number(page) - 1) * safeLimit;

        const [entries, total] = await Promise.all([
            LedgerEntry.find(filter)
                .skip(skip)
                .limit(safeLimit)
                .sort({ businessDate: -1, createdAt: -1 }),
            LedgerEntry.countDocuments(filter)
        ]);

        return {
            ledgerAccount,
            entries,
            pagination: {
                total,
                page: Number(page),
                limit: safeLimit,
                totalPages: Math.ceil(total / safeLimit)
            }
        };
    };


// ─────────────────────────────────────────────────────────
// CONSOLIDATED REPORTS
// ─────────────────────────────────────────────────────────

const getConsolidatedPigmy = async () => {
    const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
    const result = await PigmyAccount.aggregate([
        { $match: { isDeleted: false, status: 'active' } },
        { 
            $group: {
                _id: "$assignedAgent",
                totalAccounts: { $sum: 1 },
                expectedDailyCollection: { $sum: "$dailyDepositAmountInPaise" },
                totalBalance: { $sum: "$balanceInPaise" }
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "agent"
            }
        },
        { $unwind: "$agent" },
        {
            $project: {
                _id: 1,
                agentName: "$agent.name",
                agentCode: "$agent.agentCode",
                totalAccounts: 1,
                expectedDailyCollection: 1,
                totalBalance: 1
            }
        },
        { $sort: { agentName: 1 } }
    ]);
    return { data: result, asOfDate: rawBusinessDate || new Date() };
};

const getConsolidatedSavings = async () => {
    const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
    const result = await SavingAccount.aggregate([
        { $match: { isDeleted: false, status: 'active' } },
        {
            $group: {
                _id: "$assignedAgent",
                totalAccounts: { $sum: 1 },
                totalBalance: { $sum: "$balanceInPaise" }
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "agent"
            }
        },
        {
            // Left join (some savings might not have an assigned agent)
            $unwind: { path: "$agent", preserveNullAndEmptyArrays: true }
        },
        {
            $project: {
                _id: 1,
                agentName: { $ifNull: ["$agent.name", "Unassigned"] },
                agentCode: { $ifNull: ["$agent.agentCode", ""] },
                totalAccounts: 1,
                totalBalance: 1
            }
        },
        { $sort: { agentName: 1 } }
    ]);
    return { data: result, asOfDate: rawBusinessDate || new Date() };
};

const getConsolidatedLoans = async () => {
    const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
    const result = await LoanAccount.aggregate([
        { $match: { isDeleted: false, status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] } } },
        {
            $group: {
                _id: "$loanPlan",
                totalLoans: { $sum: 1 },
                principalDisbursed: { $sum: "$principalAmountInPaise" },
                totalOutstanding: { $sum: "$outstandingBalanceInPaise" },
                totalRepaid: { $sum: "$totalPaidInPaise" },
                totalPenalty: { $sum: "$penaltyAmountInPaise" },
                overdueCount: { $sum: { $cond: [{ $eq: ["$status", LOAN_STATUS.OVERDUE] }, 1, 0] } }
            }
        },
        {
            $lookup: {
                from: "loanplans",
                localField: "_id",
                foreignField: "_id",
                as: "plan"
            }
        },
        { $unwind: "$plan" },
        {
            $project: {
                _id: 1,
                planName: "$plan.planName",
                interestRate: "$plan.interestRateBps",
                durationMonths: "$plan.durationMonths",
                totalLoans: 1,
                principalDisbursed: 1,
                totalOutstanding: 1,
                totalRepaid: 1,
                totalPenalty: 1,
                overdueCount: 1
            }
        },
        { $sort: { planName: 1 } }
    ]);
    return { data: result, asOfDate: rawBusinessDate || new Date() };
};

const getConsolidatedAgents = async () => {
    const rawBusinessDate = await AppConfig.getCurrentBusinessDate();
    
    // Total Cash Held by mapping Agent's user _id to ledgerAccount, then fetching ledger balance
    const agents = await User.find({ role: ROLES.AGENT, isActive: true, isDeleted: false })
        .populate('ledgerAccount')
        .lean();
        
    // Calculate total Pigmy per agent
    const pigmyAggr = await PigmyAccount.aggregate([
        { $match: { isDeleted: false, status: 'active' } },
        { $group: { _id: "$assignedAgent", pigmyBalance: { $sum: "$balanceInPaise" } } }
    ]);
    
    // Calculate loan outstanding per agent via pigmyAccount linkage
    // LoanAccount has no direct assignedAgent — we join through pigmyAccount
    const loanAggr = await LoanAccount.aggregate([
        { $match: { isDeleted: false, status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] } } },
        {
            $lookup: {
                from: "pigmyaccounts",
                localField: "pigmyAccount",
                foreignField: "_id",
                as: "pigmy"
            }
        },
        { $unwind: "$pigmy" },
        {
            $group: {
                _id: "$pigmy.assignedAgent",
                totalOutstanding: { $sum: "$outstandingBalanceInPaise" },
                totalPenalty: { $sum: "$penaltyAmountInPaise" },
                loanCount: { $sum: 1 }
            }
        }
    ]);

    const pigmyMap = {};
    pigmyAggr.forEach(p => {
        const idStr = p._id ? p._id.toString() : 'unassigned';
        pigmyMap[idStr] = p.pigmyBalance;
    });
    
    const loanMap = {};
    loanAggr.forEach(l => {
        const idStr = l._id ? l._id.toString() : 'unassigned';
        loanMap[idStr] = l;
    });
    
    const data = agents.map(agent => {
        const key = agent._id.toString();
        const loanData = loanMap[key] || {};
        return {
            _id: agent._id,
            agentName: agent.name,
            agentCode: agent.agentCode,
            phone: agent.phone,
            pigmyBalance: pigmyMap[key] || 0,
            loanOutstanding: loanData.totalOutstanding || 0,
            loanPenalty: loanData.totalPenalty || 0,
            loanCount: loanData.loanCount || 0,
            cashInHand: agent.ledgerAccount ? agent.ledgerAccount.runningBalanceInPaise : 0
        };
    });
    
    return { data, asOfDate: rawBusinessDate || new Date() };
};


    module.exports = {
        getDashboard,
        getCollectionReport,
        getAgentPerformance,
        getLoanPortfolio,
        getOverdueReport,
        getTrialBalance,
        getPnlReport,
        getCashPosition,
        getCustomerReport,
        getDailyTransactionReport,
        getLedgerHistory,
        getConsolidatedPigmy,
        getConsolidatedSavings,
        getConsolidatedLoans,
        getConsolidatedAgents
    };
